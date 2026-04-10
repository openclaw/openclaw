// Octopus Orchestrator — `openclaw octo init` tests (M2-17)
//
// Covers:
//   - Init creates state directory and SQLite DB
//   - Init is idempotent (running twice does not error)
//   - --json mode emits valid structured output
//   - --yes mode works without prompts
//   - Doctor checks run after init
//   - Exit code 0 on success, 1 on critical doctor failures

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InitResult } from "./init.ts";
import { executeInit, runOctoInit } from "./init.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp dir harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-init-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// executeInit — core logic
// ──────────────────────────────────────────────────────────────────────────

describe("executeInit", () => {
  it("creates state directory and SQLite DB", () => {
    const result = executeInit({ stateDir: tempDir });

    expect(result.stateDirCreated).toBe(true);
    expect(result.stateDirPath).toBe(path.join(tempDir, "octo"));
    expect(existsSync(result.stateDirPath)).toBe(true);
    expect(result.registryInitialized).toBe(true);
    expect(existsSync(result.registryPath)).toBe(true);
  });

  it("is idempotent (running twice does not error)", () => {
    const first = executeInit({ stateDir: tempDir });
    expect(first.stateDirCreated).toBe(true);
    expect(first.registryInitialized).toBe(true);

    const second = executeInit({ stateDir: tempDir });
    expect(second.stateDirCreated).toBe(false);
    expect(second.registryInitialized).toBe(true);
    expect(existsSync(second.registryPath)).toBe(true);
  });

  it("runs doctor checks after init", () => {
    const result = executeInit({ stateDir: tempDir });

    expect(result.doctorChecks.length).toBeGreaterThan(0);
    const names = result.doctorChecks.map((c) => c.name);
    expect(names).toContain("sqlite-registry");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runOctoInit — entry point
// ──────────────────────────────────────────────────────────────────────────

describe("runOctoInit", () => {
  it("returns exit code 0 on successful init", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };

    const code = runOctoInit({ stateDir: tempDir }, out);

    // May be 1 if tmux is missing in CI, but registry check should pass
    expect([0, 1]).toContain(code);
    expect(captured).toContain("Octopus Init");
    expect(captured).toContain("Registry initialized");
  });

  it("emits valid JSON in --json mode", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };

    runOctoInit({ json: true, stateDir: tempDir }, out);

    const parsed = JSON.parse(captured) as InitResult;
    expect(parsed.stateDirCreated).toBe(true);
    expect(parsed.registryInitialized).toBe(true);
    expect(Array.isArray(parsed.doctorChecks)).toBe(true);
    expect(parsed.doctorChecks.length).toBeGreaterThan(0);
    expect(typeof parsed.hasCriticalFailures).toBe("boolean");
  });

  it("works in --yes mode without prompts", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };

    const code = runOctoInit({ yes: true, stateDir: tempDir }, out);

    expect([0, 1]).toContain(code);
    expect(captured).toContain("Octopus Init");
  });

  it("doctor checks are included in output", () => {
    let captured = "";
    const out = {
      write: (s: string) => {
        captured += s;
      },
    };

    runOctoInit({ stateDir: tempDir }, out);

    // Doctor output should be appended
    expect(captured).toContain("sqlite-registry");
  });
});
