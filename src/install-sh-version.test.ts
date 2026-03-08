import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function withFakeCli(versionOutput: string): { root: string; cliPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-sh-"));
  const cliPath = path.join(root, "openclaw");
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
printf '%s\n' '${versionOutput}'
`,
    "utf-8",
  );
  fs.chmodSync(cliPath, 0o755);
  return { root, cliPath };
}

function resolveVersionFromInstaller(cliPath: string): string {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `source "${installerPath}" >/dev/null 2>&1
OPENCLAW_BIN="$FAKE_OPENCLAW_BIN"
resolve_openclaw_version`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        FAKE_OPENCLAW_BIN: cliPath,
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    },
  );
  return output.trim();
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
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "extracts the semantic version from decorated CLI output",
    () => {
      const fixture = withFakeCli("OpenClaw 2026.3.8 (abcdef0)");
      tempRoots.push(fixture.root);

      expect(resolveVersionFromInstaller(fixture.cliPath)).toBe("2026.3.8");
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to raw output when no semantic version is present",
    () => {
      const fixture = withFakeCli("OpenClaw dev build");
      tempRoots.push(fixture.root);

      expect(resolveVersionFromInstaller(fixture.cliPath)).toBe("OpenClaw dev build");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not source version helpers from cwd when installer runs via stdin",
    () => {
      const fixture = withFakeCli("OpenClaw 2026.3.8 (abcdef0)");
      tempRoots.push(fixture.root);

      const hostileCwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-stdin-"));
      tempRoots.push(hostileCwd);
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

      expect(resolveVersionFromInstallerViaStdin(fixture.cliPath, hostileCwd)).toBe("2026.3.8");
    },
  );
});
