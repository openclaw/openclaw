import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

function writeExecutable(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, {
    encoding: "utf8",
    mode: 0o755,
  });
}

/**
 * Scaffold a temp git repo with the real pre-commit hook symlinked in and
 * lightweight stubs for the helper scripts.  Returns the temp dir path, the
 * fake-bin directory (prepended to PATH), and a pnpm stub that logs its
 * invocations so tests can assert whether the gate ran.
 */
function scaffoldHookRepo(): { dir: string; fakeBinDir: string; pnpmLog: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
  run(dir, "git", ["init", "-q", "--initial-branch=main"]);

  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    path.join(dir, "git-hooks", "pre-commit"),
  );
  writeFileSync(
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  // The real filter-staged-files.mjs emits NUL-delimited output.  Use a stub
  // that faithfully echoes back the inputs it receives so the hook's arrays
  // populate correctly for non-code files (empty) vs code files (non-empty).
  symlinkSync(
    path.join(process.cwd(), "scripts", "pre-commit", "filter-staged-files.mjs"),
    path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
  );

  const fakeBinDir = path.join(dir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  // node must be the real node so the filter script can actually run.
  const realNode = process.execPath;
  symlinkSync(realNode, path.join(fakeBinDir, "node"));

  const pnpmLog = path.join(dir, "pnpm-invocations.log");
  writeExecutable(fakeBinDir, "pnpm", `#!/usr/bin/env bash\necho "$@" >> "${pnpmLog}"\nexit 0\n`);

  return { dir, fakeBinDir, pnpmLog };
}

/** Build a PATH string with the fake bin dir at the front. */
function hookEnv(fakeBinDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

describe("git-hooks/pre-commit (integration)", () => {
  // ── Security regression ────────────────────────────────────────────────────
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const { dir, fakeBinDir } = scaffoldHookRepo();

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could
    // run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], hookEnv(fakeBinDir));

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });

  // ── Gate gating: non-code commits skip pnpm check ─────────────────────────
  it("skips repo-wide gate when only non-code files are staged", () => {
    const { dir, fakeBinDir, pnpmLog } = scaffoldHookRepo();

    // Provide package.json + pnpm-lock.yaml so the real-checkout condition is met.
    writeFileSync(path.join(dir, "package.json"), "{}\n", "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    // Stage a non-code file (image-like extension — not in lint or format sets).
    writeFileSync(path.join(dir, "photo.png"), "img\n", "utf8");
    run(dir, "git", ["add", "--", "photo.png"]);

    run(dir, "bash", ["git-hooks/pre-commit"], hookEnv(fakeBinDir));

    // pnpm should NOT have been invoked.
    let pnpmInvoked = false;
    try {
      readFileSync(pnpmLog, "utf8");
      pnpmInvoked = true;
    } catch {
      // File doesn't exist → pnpm was never called.
    }
    expect(pnpmInvoked).toBe(false);
  });

  // ── Gate gating: code commits DO run pnpm check ───────────────────────────
  it("runs repo-wide gate when code files are staged in a real checkout", () => {
    const { dir, fakeBinDir, pnpmLog } = scaffoldHookRepo();

    writeFileSync(path.join(dir, "package.json"), "{}\n", "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    // Stage a TypeScript file (lint + format target).
    writeFileSync(path.join(dir, "index.ts"), "export {};\n", "utf8");
    run(dir, "git", ["add", "--", "index.ts"]);

    run(dir, "bash", ["git-hooks/pre-commit"], hookEnv(fakeBinDir));

    const invocations = readFileSync(pnpmLog, "utf8").trim();
    expect(invocations).toContain("check");
  });

  // ── OPENCLAW_SKIP_CHECK bypass ─────────────────────────────────────────────
  it("skips repo-wide gate when OPENCLAW_SKIP_CHECK is set", () => {
    const { dir, fakeBinDir, pnpmLog } = scaffoldHookRepo();

    writeFileSync(path.join(dir, "package.json"), "{}\n", "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    // Stage a code file that would normally trigger the gate.
    writeFileSync(path.join(dir, "index.ts"), "export {};\n", "utf8");
    run(dir, "git", ["add", "--", "index.ts"]);

    run(
      dir,
      "bash",
      ["git-hooks/pre-commit"],
      hookEnv(fakeBinDir, {
        OPENCLAW_SKIP_CHECK: "1",
      }),
    );

    // pnpm should NOT have been invoked despite code files being staged.
    let pnpmInvoked = false;
    try {
      readFileSync(pnpmLog, "utf8");
      pnpmInvoked = true;
    } catch {
      // File doesn't exist → pnpm was never called.
    }
    expect(pnpmInvoked).toBe(false);
  });

  // ── Re-stage gating: git-add only runs when tools ran ─────────────────────
  it("does not re-stage files when no tools ran", () => {
    const { dir, fakeBinDir } = scaffoldHookRepo();

    // Stage only a non-code file — neither lint nor format tools will run.
    writeFileSync(path.join(dir, "notes.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "notes.txt"]);

    // Also create an unstaged modification to ensure `git add` is not called
    // (which would re-stage any worktree changes to the same file).
    writeFileSync(path.join(dir, "notes.txt"), "modified\n", "utf8");

    run(dir, "bash", ["git-hooks/pre-commit"], hookEnv(fakeBinDir));

    // The staged content should still be "hello", not "modified".
    const stagedContent = run(dir, "git", ["show", ":notes.txt"]);
    expect(stagedContent).toBe("hello");
  });
});
