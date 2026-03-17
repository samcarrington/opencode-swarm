/**
 * Tests for project-level preferred linter configuration.
 *
 * Verifies that `config.lint.linter` in `.opencode/opencode-swarm.json`
 * overrides the default biome-first auto-detection order, allowing projects
 * to specify a preferred linter (e.g. ruff for Python projects) even when
 * biome is globally available via npx.
 *
 * Uses bun:test with real temp directories so loadPluginConfig reads actual
 * config files — no fs mocking required, no cross-file contamination.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { LintSuccessResult, LintErrorResult } from '../../../src/tools/lint';
import { lint } from '../../../src/tools/lint';

// ---- Spawn mock ----------------------------------------------------------------

let originalSpawn: typeof Bun.spawn;
let mockSpawnFn: ((cmd: string[], opts: unknown) => ReturnType<typeof Bun.spawn>) | null = null;

function makeStream(content: string): ReadableStream {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(content));
			controller.close();
		},
	});
}

function makeProc(stdout = '', stderr = '', exitCode = 0) {
	return {
		stdout: makeStream(stdout),
		stderr: makeStream(stderr),
		exited: Promise.resolve(exitCode),
		exitCode,
	} as unknown as ReturnType<typeof Bun.spawn>;
}

// ---- Temp directory helpers ----------------------------------------------------

let tempDir: string;

function createProjectWithConfig(linterValue: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-test-'));
	const opencodePath = path.join(dir, '.opencode');
	fs.mkdirSync(opencodePath);
	fs.writeFileSync(
		path.join(opencodePath, 'opencode-swarm.json'),
		JSON.stringify({ lint: { linter: linterValue } }),
	);
	return dir;
}

function cleanupDir(dir: string) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

// ---- Lifecycle -----------------------------------------------------------------

beforeEach(() => {
	originalSpawn = Bun.spawn;
	mockSpawnFn = null;
	Bun.spawn = ((cmd: string[], opts: unknown) => {
		if (mockSpawnFn) return mockSpawnFn(cmd, opts);
		return originalSpawn(cmd as [string, ...string[]], opts as Parameters<typeof Bun.spawn>[1]);
	}) as typeof Bun.spawn;
	tempDir = '';
});

afterEach(() => {
	Bun.spawn = originalSpawn;
	mockSpawnFn = null;
	if (tempDir) cleanupDir(tempDir);
});

// ---- Tests ---------------------------------------------------------------------

describe('lint tool - project-level preferred linter', () => {
	describe('primary use case: biome globally available but ruff preferred (Python project)', () => {
		it('uses ruff directly, never spawning biome, even when biome is globally available via npx', async () => {
			tempDir = createProjectWithConfig('ruff');
			const spawnCmds: string[][] = [];
			mockSpawnFn = (cmd) => {
				spawnCmds.push(cmd);
				return makeProc('No issues found');
			};

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('ruff');

			// biome must NOT have been spawned
			const usedBiome = spawnCmds.some((cmd) => cmd.some((arg) => arg.includes('biome')));
			expect(usedBiome).toBe(false);
			// ruff must have been spawned
			const usedRuff = spawnCmds.some((cmd) => cmd[0] === 'ruff');
			expect(usedRuff).toBe(true);
		});

		it('uses ruff --fix in fix mode for a Python project', async () => {
			tempDir = createProjectWithConfig('ruff');
			let capturedCmd: string[] = [];
			mockSpawnFn = (cmd) => {
				capturedCmd = cmd;
				return makeProc('Fixed 2 issues');
			};

			const raw = await lint.execute({ mode: 'fix' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('ruff');
			expect(result.mode).toBe('fix');
			expect(capturedCmd[0]).toBe('ruff');
			expect(capturedCmd).toContain('--fix');
		});
	});

	describe('preferred linter: biome (explicit)', () => {
		it('uses biome directly when config.lint.linter = "biome"', async () => {
			tempDir = createProjectWithConfig('biome');
			mockSpawnFn = () => makeProc('All good');

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('biome');
		});
	});

	describe('preferred linter: eslint (explicit)', () => {
		it('uses eslint directly when config.lint.linter = "eslint"', async () => {
			tempDir = createProjectWithConfig('eslint');
			mockSpawnFn = () => makeProc('No problems');

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('eslint');
		});
	});

	describe('preferred linter: clippy (Rust project)', () => {
		it('uses clippy directly when config.lint.linter = "clippy"', async () => {
			tempDir = createProjectWithConfig('clippy');
			let capturedCmd: string[] = [];
			mockSpawnFn = (cmd) => {
				capturedCmd = cmd;
				return makeProc('warning: unused variable');
			};

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('clippy');
			expect(capturedCmd[0]).toBe('cargo');
			expect(capturedCmd).toContain('clippy');
		});
	});

	describe('preferred linter: auto (default behaviour)', () => {
		it('falls through to auto-detection when config.lint.linter = "auto"', async () => {
			tempDir = createProjectWithConfig('auto');
			mockSpawnFn = () => makeProc('biome 1.0.0');

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('biome');
		});

		it('falls through to auto-detection when no lint config section is present', async () => {
			// tempDir with no .opencode config → loadPluginConfig returns defaults
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-test-noconfig-'));
			mockSpawnFn = () => makeProc('biome 1.0.0');

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintSuccessResult;

			expect(result.success).toBe(true);
			expect(result.linter).toBe('biome');
		});
	});

	describe('preferred linter: all additional linters', () => {
		const additionalLinters = [
			'ruff',
			'clippy',
			'golangci-lint',
			'checkstyle',
			'ktlint',
			'dotnet-format',
			'cppcheck',
			'swiftlint',
			'dart-analyze',
			'rubocop',
		] as const;

		for (const linterName of additionalLinters) {
			it(`uses ${linterName} directly when config.lint.linter = "${linterName}"`, async () => {
				tempDir = createProjectWithConfig(linterName);
				mockSpawnFn = () => makeProc('ok');

				const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
				const result = JSON.parse(raw) as LintSuccessResult;

				expect(result.success).toBe(true);
				expect(result.linter).toBe(linterName);
			});
		}
	});

	describe('preferred linter error propagation', () => {
		it('returns error result when preferred linter command fails', async () => {
			tempDir = createProjectWithConfig('ruff');
			mockSpawnFn = () => {
				throw new Error('ruff not found');
			};

			const raw = await lint.execute({ mode: 'check' }, { directory: tempDir } as any);
			const result = JSON.parse(raw) as LintErrorResult;

			expect(result.success).toBe(false);
			expect(result.linter).toBe('ruff');
			expect(result.error).toContain('Execution failed');
		});
	});
});

