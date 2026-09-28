import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const wrapper = join(process.cwd(), "scripts/pr");

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describePosix("scripts/pr host tooling", () => {
  it("rejects a failing selected Git before reading wrapper code", () => {
    const result = spawnSync("/bin/bash", [wrapper, "ls"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, OPENCLAW_PR_GIT: "/bin/false" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git preflight failed or exceeded 10 seconds: /bin/false");
    expect(result.stderr).toContain("xcode-select -p:");
    expect(result.stderr).toContain(
      "export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer or set OPENCLAW_PR_GIT",
    );
    expect(result.stderr).not.toContain("uncommitted changes");
  });

  it("bounds a hung Git launcher and its child at ten seconds", () => {
    const root = tempDirs.make("openclaw-pr-hung-git-");
    const git = executable(join(root, "sleeping-git"), "sleep 60");
    const started = Date.now();
    const result = spawnSync("/bin/bash", [wrapper, "ls"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, OPENCLAW_PR_GIT: git },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
    expect(result.stderr).toContain(`git preflight failed or exceeded 10 seconds: ${git}`);
  }, 20_000);

  it("passes the selected Git to supervised descendants and removes its PATH adapter", () => {
    const root = tempDirs.make("openclaw-pr-selected-git-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    executable(join(bin, "git"), 'echo "wrong PATH Git" >&2; exit 99');
    const git = executable(join(root, "custom-git"), 'printf "selected Git: %s\\n" "$*"');
    const operation = executable(
      join(root, "operation"),
      "set -e\ngit --version\nprintf 'phase\\toperation-complete\\n' >&3",
    );
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts/pr-lib/process-group-runner.mjs"), root, operation],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          OPENCLAW_PR_GIT: git,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: root,
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("selected Git: --version\n");
    expect(
      readdirSync(root).filter((entry) => entry.startsWith("openclaw-pr-lock-release-")),
    ).toEqual([]);
  });

  it("bounds the Python process-identity fallback when its launcher hangs", () => {
    const root = tempDirs.make("openclaw-pr-hung-python-");
    executable(join(root, "python3"), "sleep 60");
    const started = Date.now();
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; uname() { echo Darwin; }; pr_operation_lock_darwin_identity identity "$$"',
        "pr-python-preflight",
        join(process.cwd(), "scripts/pr-lib/operation-lock.sh"),
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
  }, 20_000);
});
