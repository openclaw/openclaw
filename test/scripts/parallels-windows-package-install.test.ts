import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  encodePowerShell,
  windowsPackageInstallScript,
} from "../../scripts/e2e/parallels/powershell.ts";

describe.runIf(process.platform === "win32")("Windows package install notices", () => {
  it.each([0, 23])("preserves npm exit code %i when npm writes a notice", (exitCode) => {
    const script = `
function curl.exe { $global:LASTEXITCODE = 0 }
function npm.cmd { & $env:ComSpec /d /s /c 'echo npm notice 1>&2 & exit /b ${exitCode}' }
function Invoke-OpenClaw { Write-Output 'OpenClaw fixture'; $global:LASTEXITCODE = 0 }
try {
  & {
${windowsPackageInstallScript("https://example.test/openclaw.tgz", "openclaw-fixture.tgz")}
  } *>&1 | Out-String | Write-Output
  exit 0
} catch {
  Write-Output $_
  exit 1
}`;
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
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
