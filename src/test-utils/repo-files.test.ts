import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_LS_FILES_TIMEOUT_MS, listGitTrackedFiles } from "./repo-files.js";

// These tests exercise the production `git ls-files` probe exported from
// src/test-utils/repo-files.ts. They serve as the runtime behavior proof
// requested by ClawSweeper for PR #111171:
//   1. The probe returns the tracked files in a normal repo.
//   2. The probe times out and falls back to null when git hangs.
//
// ClawSweeper's earlier review noted the test previously exercised a
// *copied* spawnSync shape instead of the production helper, leaving an
// availability regression unprotected if a future edit removed the
// production timeout or killSignal:
//
// > A narrow mechanical repair can make the new regression test cover the
// > actual helper; contributor-supplied real-behavior evidence remains a
// > separate merge gate.
//
// We now import `listGitTrackedFiles` and `GIT_LS_FILES_TIMEOUT_MS`
// directly from the production module so any future change to the
// production timeout, killSignal, or spawn shape is automatically
// covered by this regression test.
//
// The module-level cache in `repo-files.ts` is keyed on repoRoot +
// pathspecs, and each test below uses a fresh `mkdtempSync` repoRoot, so
// the cache cannot interfere with the runtime proof.

describe("repo-files listGitTrackedFiles probe", () => {
  let repoRoot: string;
  let stubDir: string | null = null;
  let originalPath: string | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "openclaw-repo-files-"));
    mkdirSync(join(repoRoot, "src"));
    spawnSync("git", ["init", repoRoot], {
      encoding: "utf8",
      env: { ...process.env, GIT_DEFAULT_BRANCH: "main" },
    });
    spawnSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", repoRoot, "config", "user.name", "Test"], { encoding: "utf8" });
    writeFileSync(join(repoRoot, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repoRoot, "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(repoRoot, "README.md"), "# test\n");
    spawnSync("git", ["-C", repoRoot, "add", "src/a.ts", "src/b.ts", "README.md"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", repoRoot, "commit", "-m", "init"], { encoding: "utf8" });
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (stubDir) {
      rmSync(stubDir, { recursive: true, force: true });
      stubDir = null;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("exports the documented probe timeout budget", () => {
    // Structural guard: the production budget is 5s. If a future change
    // raises or lowers this without intent, the runtime proof below would
    // silently still pass at a different deadline. Pinning the value here
    // forces the author to acknowledge the change.
    expect(GIT_LS_FILES_TIMEOUT_MS).toBe(5_000);
  });

  it("returns tracked files matching pathspecs in a normal repo", () => {
    const files = listGitTrackedFiles({ pathspecs: "src/*.ts", repoRoot });
    expect(files).not.toBeNull();
    expect(files).toStrictEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(files).not.toContain("README.md");
  });

  it("times out and returns null when git hangs (SIGKILL runtime proof)", () => {
    // Install a fake `git` on PATH that ignores SIGTERM and SIGINT and
    // sleeps forever. The production code uses killSignal: "SIGKILL", so
    // the fake will be hard-killed at the deadline and spawnSync returns
    // status === null && signal === "SIGKILL". The caller must fall back
    // to null (cached), not hang the test suite.
    stubDir = mkdtempSync(join(tmpdir(), "openclaw-repo-files-stub-"));
    const fakeGit = join(stubDir, "git");
    writeFileSync(fakeGit, '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n');
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${stubDir}:${originalPath ?? ""}`;

    const start = Date.now();
    const files = listGitTrackedFiles({ pathspecs: "src/*.ts", repoRoot });
    const elapsed = Date.now() - start;

    // Must fall back to null instead of hanging.
    expect(files).toBeNull();
    // Must return promptly. Allow generous slack for CI scheduling.
    expect(elapsed).toBeLessThan(10_000);
    // Must have actually waited at least ~5s (the SIGKILL deadline).
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 15_000);
});
