import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../test/helpers/temp-dir.js";

const tempRoots: string[] = [];

function withFakeCli(versionOutput: string): { root: string; cliPath: string } {
  const root = makeTempDir(tempRoots, "openclaw-install-sh-");
  const cliPath = path.join(root, "openclaw");
  const escapedOutput = versionOutput.replace(/'/g, "'\\''");
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
printf '%s\n' '${escapedOutput}'
`,
    "utf-8",
  );
  fs.chmodSync(cliPath, 0o755);
  return { root, cliPath };
}

function resolveVersionsFromInstaller(cliPaths: string[]): string[] {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `source "${installerPath}" >/dev/null 2>&1
for openclaw_bin in "$@"; do
  OPENCLAW_BIN="$openclaw_bin"
  resolve_openclaw_version
done`,
      "openclaw-version-test",
      ...cliPaths,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    },
  );
  return output.trimEnd().split("\n");
}

function resolveVersionFromInstallerViaStdin(cliPath: string, cwd: string): string {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const installerSource = fs.readFileSync(installerPath, "utf-8");
  const output = execFileSync("bash", [], {
    cwd,
    encoding: "utf-8",
    input: `${installerSource}
OPENCLAW_BIN="$FAKE_OPENCLAW_BIN"
resolve_openclaw_version
`,
    env: {
      ...process.env,
      FAKE_OPENCLAW_BIN: cliPath,
      OPENCLAW_INSTALL_SH_NO_RUN: "1",
    },
  });
  return output.trim();
}

describe("install.sh version resolution", () => {
  afterEach(() => {
    cleanupTempDirs(tempRoots);
  });

  it.runIf(process.platform !== "win32")("parses decorated and raw CLI versions", () => {
    const decorated = withFakeCli("OpenClaw 2026.3.10 (abcdef0)");
    const raw = withFakeCli("OpenClaw dev's build");

    expect(resolveVersionsFromInstaller([decorated.cliPath, raw.cliPath])).toEqual([
      "2026.3.10",
      "OpenClaw dev's build",
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "does not source version helpers from cwd when installer runs via stdin",
    () => {
      const fixture = withFakeCli("OpenClaw 2026.3.10 (abcdef0)");

      const hostileCwd = makeTempDir(tempRoots, "openclaw-install-stdin-");
      const hostileHelper = path.join(
        hostileCwd,
        "docker",
        "install-sh-common",
        "version-parse.sh",
      );
      fs.mkdirSync(path.dirname(hostileHelper), { recursive: true });
      fs.writeFileSync(
        hostileHelper,
        `#!/usr/bin/env bash
extract_openclaw_semver() {
  printf '%s' 'poisoned'
}
`,
        "utf-8",
      );

      expect(resolveVersionFromInstallerViaStdin(fixture.cliPath, hostileCwd)).toBe("2026.3.10");
    },
  );
});
