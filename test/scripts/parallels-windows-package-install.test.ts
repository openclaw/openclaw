import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodePowerShell } from "../../scripts/e2e/parallels/powershell.ts";
import { windowsPackageInstallProbe } from "./parallels-windows-package-install.test-support.js";

describe.runIf(process.platform === "win32")("Windows package install handoff", () => {
  it.each([
    [0, false],
    [0, true],
    [23, false],
  ] as const)("preserves npm status %i and existing PATH (%s)", (exitCode, alreadyOnPath) => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(windowsPackageInstallProbe(exitCode, alreadyOnPath)),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode === 0 ? 0 : 1);
    if (exitCode === 0) {
      expect(result.stdout).toContain("npm notice");
    }
    expect(result.stdout).toContain(
      exitCode === 0 ? "OpenClaw fixture" : "npm install failed with exit code 23",
    );
  });
});
