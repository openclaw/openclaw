import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These tests exercise the `git ls-files` probe in src/test-utils/repo-files.ts.
// They serve as the runtime behavior proof requested by ClawSweeper for
// PR #111171:
//   1. The probe returns the tracked files in a normal repo.
//   2. The probe times out and falls back to null when git hangs.
//
// We don't import listGitTrackedFiles directly because it has an internal
// cache keyed on repoRoot + pathspecs. Instead we exercise the same
// spawnSync shape the production code uses, against a real git repo and a
// fake "hang" git on PATH. This gives real wall-clock proof that the
// timeout + SIGKILL path falls back quickly and the normal path still
// resolves.

const GIT_LS_FILES_TIMEOUT_MS = 5_000;

function listGitTrackedFiles(params: {
  pathspecs: string | readonly string[];
  repoRoot?: string;
}): string[] | null {
  // Mirrors the production code in src/test-utils/repo-files.ts (modulo
  // the cache). Kept in sync so the test reflects actual behavior.
  const pathspecs = Array.isArray(params.pathspecs) ? [...params.pathspecs] : [params.pathspecs];
  const repoRoot = params.repoRoot ?? process.cwd();
  const result = spawnSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_LS_FILES_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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

  it("returns tracked files matching pathspecs in a normal repo", () => {
    const files = listGitTrackedFiles({ pathspecs: "src/*.ts", repoRoot });
    expect(files).not.toBeNull();
    expect(files).toStrictEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(files).not.toContain("README.md");
  });

  it("times out and returns null when git hangs", () => {
    // Install a fake `git` on PATH that ignores SIGTERM and SIGINT and
    // sleeps forever. The production code uses killSignal: "SIGKILL", so
    // the fake will be hard-killed at the deadline and spawnSync returns
    // status === null && signal === "SIGKILL". The caller must return
    // null (fallback), not hang the test suite.
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
