import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const BUILD_INFO_COMMIT_SCRIPT = path.resolve(
  "scripts/e2e/lib/parallels-package/build-info-commit.mjs",
);
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runBash(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("Parallels lib helpers", () => {
  it("reads build-info commit metadata from the current package cwd", () => {
    const root = makeTempDir(tempDirs, "openclaw-parallels-build-info-");

    const missingResult = spawnSync(process.execPath, [BUILD_INFO_COMMIT_SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(missingResult.status).toBe(0);
    expect(missingResult.stdout).toBe("\n");

    mkdirSync(path.join(root, "dist"));
    writeFileSync(
      path.join(root, "dist", "build-info.json"),
      `${JSON.stringify({ commit: "abc123" })}\n`,
    );
    const result = spawnSync(process.execPath, [BUILD_INFO_COMMIT_SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("abc123\n");
  });

  it("reclaims stale package shell locks and releases current locks", () => {
    const root = makeTempDir(tempDirs, "openclaw-parallels-package-lock-");
    const lockDir = path.join(root, "build.lock");
    const result = runBash(`
set -euo pipefail
source scripts/e2e/lib/parallels-package-common.sh
lock_dir=${shellQuote(lockDir)}
mkdir -p "$lock_dir"
printf '%s\\n' 999999999 >"$lock_dir/pid"
parallels_package_acquire_build_lock "$lock_dir"
owner="$(cat "$lock_dir/pid")"
parallels_package_release_build_lock "$lock_dir"
printf 'owner=%s exists=%s\\n' "$owner" "$([[ -e "$lock_dir" ]] && echo yes || echo no)"
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("warn: Removing stale Parallels build lock");
    expect(result.stdout).toMatch(/^owner=\d+ exists=no\n$/u);
    expect(result.stdout).not.toContain("owner=999999999");
  });

  it("resolves macOS desktop users through prlctl fallbacks", () => {
    const root = makeTempDir(tempDirs, "openclaw-parallels-macos-common-");
    const binDir = path.join(root, "bin");
    const macHome = `${"/"}Users/alice`;
    mkdirSync(binDir);
    const prlctlShim = path.join(binDir, "prlctl");
    writeFileSync(
      prlctlShim,
      `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/usr/bin/stat -f %Su /dev/console"* ]]; then
  printf 'loginwindow\\r\\n'
  exit 0
fi
if [[ "$args" == *"/usr/bin/dscl . -list /Users NFSHomeDirectory"* ]]; then
  printf '_daemon /var/root\\r\\nShared %s\\r\\nalice %s\\r\\n' "${`${"/"}Users/Shared`}" "${macHome}"
  exit 0
fi
if [[ "$args" == *"-read ${macHome} NFSHomeDirectory"* ]]; then
  printf 'NFSHomeDirectory: %s\\r\\n' "${macHome}"
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlShim, 0o755);

    const result = runBash(
      `
set -euo pipefail
source scripts/e2e/lib/parallels-macos-common.sh
printf 'user=%s\\n' "$(parallels_macos_resolve_desktop_user macos-vm)"
printf 'home=%s\\n' "$(parallels_macos_resolve_desktop_home macos-vm alice)"
`,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`user=alice\nhome=${macHome}\n`);
  });
});
