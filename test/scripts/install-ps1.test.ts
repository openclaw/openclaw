import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractFunctionBody } from "./install-ps1.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";
const SCRIPT_PATH = "scripts/install.ps1";
const source = readFileSync(SCRIPT_PATH, "utf8");
const body = (name: string) => extractFunctionBody(source, name);
const contracts: Record<string, Record<string, string>> = {
  "pipes the SQLite probe to an application Node executable": {
    "Check-Node": `Get-Command node -CommandType Application
SELECT sqlite_version() AS version
$sqliteProbe | & $nodePath -`,
  },
  "runs Windows command shims from a Windows-local cwd": {
    "Invoke-CommandFromWindowsSafeDirectory": `Get-WindowsCommandSafeDirectory
$WorkingDirectory
Push-Location -LiteralPath $safeDir
& $CommandPath @Arguments
Pop-Location`,
    "Invoke-NpmCommand": "Invoke-CommandFromWindowsSafeDirectory",
    "Ensure-OpenClawOnPath": 'Invoke-NpmCommand -Arguments @("config", "get", "prefix")',
    "Ensure-Pnpm": `@("enable", "--install-directory", $InstallDirectory, "pnpm")
Invoke-NpmCommand -CommandPath $npmCommand -Arguments $installArgs`,
    Main: `Remove-PreviousNpmOwner
Remove-PreviousGitWrapper
Start-NpmShimBackup
Restore-NpmShimBackup
Complete-NpmShimBackup
Invoke-NpmCommand -Arguments @("list", "-g", "--depth", "0", "--json")`,
  },
  "rejects OpenClaw GitHub source targets for npm installs": {
    "Test-OpenClawSourcePackageInstallSpec": `$normalizedTag -eq "main"
^github:openclaw/openclaw`,
    "Install-OpenClaw": `Test-OpenClawSourcePackageInstallSpec -RequestedTag $Tag
npm installs do not support OpenClaw GitHub source targets
-InstallMethod git -Tag main`,
  },
  "preserves caller-relative local tarball install specs before safe-cwd npm calls": {
    "Resolve-NpmOpenClawInstallSpec": "Resolve-LocalNpmPackageInstallSpec -InstallSpec $trimmedTag",
    "Resolve-LocalNpmPackageInstallSpec": String.raw`$InstallSpec -match '^file:(?<path>.+)$'
Resolve-LocalNpmPackagePath -PackagePath $filePath
).AbsoluteUri
$InstallSpec -notmatch '^\.\.?[\\/]'
$InstallSpec -notmatch '\.tgz$'`,
    "Resolve-LocalNpmPackagePath": `Resolve-Path -LiteralPath $PackagePath
[System.IO.Path]::GetFullPath($PackagePath)`,
  },
};
it.each(Object.entries(contracts))("install.ps1 %s", (_name, functions) => {
  for (const [name, fragments] of Object.entries(functions)) {
    fragments.split("\n").forEach((fragment) => expect(body(name)).toContain(fragment));
  }
  if ("Check-Node" in functions) {
    expect(body("Check-Node")).not.toContain("& $nodePath -e");
  }
});
it("does not read project npmrc when choosing global install freshness args", () => {
  const rawKeyBody = body("Test-NpmConfigRawKey");
  expect(rawKeyBody).not.toContain("Get-Location");
  expect(rawKeyBody).not.toContain('Join-Path (Get-Location) ".npmrc"');
});
it("preserves the min-release-age probe status before raw npmrc detection", () => {
  const npmInstallBody = body("Install-OpenClaw");
  const probeStatusCapture = npmInstallBody.indexOf("$minReleaseAgeStatus = $LASTEXITCODE");
  const rawKeyProbe = npmInstallBody.indexOf("Test-NpmConfigRawKey -Key");
  expect(probeStatusCapture).toBeGreaterThan(-1);
  expect(probeStatusCapture).toBeLessThan(rawKeyProbe);
  [
    "} elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge",
    'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "min-release-age", "--global")',
    'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "before", "--global")',
  ].forEach((fragment) => expect(npmInstallBody).toContain(fragment));
});
const harness = createScriptTestHarness();
const powershell = process.platform === "win32" ? "powershell" : "pwsh";
const probe = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
const runWithPowerShell = probe.status === 0 ? it : it.skip;
runWithPowerShell.each(["file", "streamed"] as const)(
  "preserves handled failure and caller lifetime through the %s installer entrypoint",
  (mode) => {
    const nodePrefix = join(harness.createTempDir("openclaw-install-failure-"), "private-node");
    const scriptPath = join(process.cwd(), SCRIPT_PATH).replaceAll("'", "''");
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        ...(mode === "file"
          ? ["-File", SCRIPT_PATH, "-NodePrefix", nodePrefix, "-DryRun"]
          : [
              "-Command",
              `try {
  & ([scriptblock]::Create((Get-Content -LiteralPath '${scriptPath}' -Raw))) -NodePrefix '${nodePrefix.replaceAll("'", "''")}' -DryRun
} catch {
  if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 2.') { throw }
  Write-Output 'caught canonical failure'
}
Write-Output 'installer caller survived'`,
            ]),
      ],
      { encoding: "utf8" },
    );
    const output = result.stdout.replace(/\r\n/g, "\n");
    expect(result.status, result.stdout + result.stderr).toBe(mode === "file" ? 2 : 0);
    expect(result.stderr).toBe("");
    expect(output).toContain("Error: -NodePrefix and -NodeVersion require -NodeOnly.");
    expect(output.match(/Support: https:\/\/community\.openclaw\.ai\//g)).toHaveLength(1);
    if (mode === "streamed") {
      expect(output).toContain("caught canonical failure\ninstaller caller survived\n");
    }
  },
);
runWithPowerShell(
  "offers support and self-service in Windows installer help without installing",
  () => {
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT_PATH,
        "-Help",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Support: https://community.openclaw.ai/");
    expect(result.stdout).toContain("FAQ: https://docs.openclaw.ai/start/faq");
  },
);
runWithPowerShell.each(["valid", "missing-head", "broken-gitfile", "subdirectory"])(
  "preserves real Git checkout boundaries before package setup: %s",
  (scenario) => {
    const result = spawnSync(
      powershell,
      [
        ..."-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass".split(" "),
        "-File",
        "test/scripts/install-git-worktree.ps1",
        "-InstallerPath",
        join(process.cwd(), SCRIPT_PATH),
        "-FixtureRoot",
        join(harness.createTempDir("openclaw-install-worktree-"), "fixture"),
        "-Scenario",
        scenario,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);
