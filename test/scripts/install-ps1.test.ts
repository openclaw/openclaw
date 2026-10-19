import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFunctionBody } from "./install-ps1.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const SCRIPT_PATH = "scripts/install.ps1";

describe("install.ps1 source contracts", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  it("pipes the SQLite probe to an application Node executable", () => {
    const checkNodeBody = extractFunctionBody(source, "Check-Node");
    expect(checkNodeBody).toContain("Get-Command node -CommandType Application");
    expect(checkNodeBody).toContain("SELECT sqlite_version() AS version");
    expect(checkNodeBody).toContain("$sqliteProbe | & $nodePath -");
    expect(checkNodeBody).not.toContain("& $nodePath -e");
  });

  const harness = createScriptTestHarness();
  const powershell = process.platform === "win32" ? "powershell" : "pwsh";
  const available =
    spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]).status === 0;
  const runWithPowerShell = available ? it : it.skip;

  runWithPowerShell.each(["valid", "missing-head", "broken-gitfile", "subdirectory"])(
    "preserves real Git checkout boundaries before package setup: %s",
    (scenario) => {
      const root = join(harness.createTempDir("openclaw-install-worktree-"), "fixture");
      const result = spawnSync(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "test/scripts/install-git-worktree.ps1",
          "-InstallerPath",
          join(process.cwd(), SCRIPT_PATH),
          "-FixtureRoot",
          root,
          "-Scenario",
          scenario,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it("runs Windows command shims from a Windows-local cwd", () => {
    const commandSafeBody = extractFunctionBody(source, "Invoke-CommandFromWindowsSafeDirectory");
    const npmCommandBody = extractFunctionBody(source, "Invoke-NpmCommand");
    const openClawPathBody = extractFunctionBody(source, "Ensure-OpenClawOnPath");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const mainBody = extractFunctionBody(source, "Main");

    expect(commandSafeBody).toContain("Get-WindowsCommandSafeDirectory");
    expect(commandSafeBody).toContain("$WorkingDirectory");
    expect(commandSafeBody).toContain("Push-Location -LiteralPath $safeDir");
    expect(commandSafeBody).toContain("& $CommandPath @Arguments");
    expect(commandSafeBody).toContain("Pop-Location");
    expect(npmCommandBody).toContain("Invoke-CommandFromWindowsSafeDirectory");
    expect(openClawPathBody).toContain('Invoke-NpmCommand -Arguments @("config", "get", "prefix")');
    expect(ensurePnpmBody).toContain(
      '@("enable", "--install-directory", $InstallDirectory, "pnpm")',
    );
    expect(ensurePnpmBody).toContain(
      "Invoke-NpmCommand -CommandPath $npmCommand -Arguments $installArgs",
    );
    expect(mainBody).toContain("Remove-PreviousNpmOwner");
    expect(mainBody).toContain("Remove-PreviousGitWrapper");
    expect(mainBody).toContain("Start-NpmShimBackup");
    expect(mainBody).toContain("Restore-NpmShimBackup");
    expect(mainBody).toContain("Complete-NpmShimBackup");
    expect(mainBody).toContain(
      'Invoke-NpmCommand -Arguments @("list", "-g", "--depth", "0", "--json")',
    );
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const sourceTargetBody = extractFunctionBody(source, "Test-OpenClawSourcePackageInstallSpec");
    expect(sourceTargetBody).toContain('$normalizedTag -eq "main"');
    expect(sourceTargetBody).toContain("^github:openclaw/openclaw");
    expect(npmInstallBody).toContain("Test-OpenClawSourcePackageInstallSpec -RequestedTag $Tag");
    expect(npmInstallBody).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(npmInstallBody).toContain("-InstallMethod git -Tag main");
  });

  it("does not read project npmrc when choosing global install freshness args", () => {
    const rawKeyBody = extractFunctionBody(source, "Test-NpmConfigRawKey");
    expect(rawKeyBody).not.toContain("Get-Location");
    expect(rawKeyBody).not.toContain('Join-Path (Get-Location) ".npmrc"');
  });

  it("preserves the min-release-age probe status before raw npmrc detection", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const probeStatusCapture = npmInstallBody.indexOf("$minReleaseAgeStatus = $LASTEXITCODE");
    const rawKeyProbe = npmInstallBody.indexOf("Test-NpmConfigRawKey -Key");
    expect(probeStatusCapture).toBeGreaterThan(-1);
    expect(rawKeyProbe).toBeGreaterThan(-1);
    expect(probeStatusCapture).toBeLessThan(rawKeyProbe);
    expect(npmInstallBody).toContain(
      "} elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge",
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "min-release-age", "--global")',
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -CommandPath $npmCommand -WorkingDirectory $npmCwd -Arguments @("config", "get", "before", "--global")',
    );
  });

  it("preserves caller-relative local tarball install specs before safe-cwd npm calls", () => {
    const resolveSpecBody = extractFunctionBody(source, "Resolve-NpmOpenClawInstallSpec");
    const localSpecBody = extractFunctionBody(source, "Resolve-LocalNpmPackageInstallSpec");
    const localPathBody = extractFunctionBody(source, "Resolve-LocalNpmPackagePath");

    expect(resolveSpecBody).toContain(
      "Resolve-LocalNpmPackageInstallSpec -InstallSpec $trimmedTag",
    );
    expect(localSpecBody).toContain("$InstallSpec -match '^file:(?<path>.+)$'");
    expect(localSpecBody).toContain("Resolve-LocalNpmPackagePath -PackagePath $filePath");
    expect(localSpecBody).toContain(").AbsoluteUri");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '^\\.\\.?[\\\\/]'");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '\\.tgz$'");
    expect(localPathBody).toContain("Resolve-Path -LiteralPath $PackagePath");
    expect(localPathBody).toContain("[System.IO.Path]::GetFullPath($PackagePath)");
  });
});
