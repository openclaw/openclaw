import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

type RetainedLauncherHarness = {
  source: string;
  engine: string;
  enabled: boolean;
  createTempDir: (prefix: string) => string;
  extractFunctionBody: (source: string, name: string) => string;
  quote: (value: string) => string;
  runPowerShell: (args: string[]) => { status: number | null; stdout: string; stderr: string };
};

export function registerRetainedGitLauncherTests(harness: RetainedLauncherHarness) {
  it.runIf(harness.enabled)(
    `installs retained CLI launchers without the new command and preserves foreign owners (${harness.engine})`,
    () => {
      const root = harness.createTempDir("openclaw-retained-launcher-");
      const entry = join(root, "checkout", "dist", "entry.js");
      mkdirSync(join(root, "checkout", "dist"), { recursive: true });
      // Released CLIs handle --help before update actions. Exercise both observed
      // Commander missing-command forms, never infer support from a version label.
      writeFileSync(
        entry,
        String.raw`
const fs = require("node:fs");
const mode = fs.readFileSync(__filename + ".mode", "utf8");
if (process.argv.includes("--help")) {
  if (mode === "unknown") { console.error("error: unknown command 'install-git-launcher'"); process.exit(1); }
  if (mode === "broken") { console.error("CLI startup failed"); process.exit(47); }
  console.log("Usage: openclaw update [options] [command]"); process.exit(0);
}
if (process.argv.includes("--version")) { console.log("retained-release-fixture"); process.exit(0); }
throw new Error("Retained CLI must not receive the missing launcher command");
`,
      );
      const script = join(root, "retained.ps1");
      writeFileSync(
        script,
        [
          ...[
            "Test-NodeVersionSupported",
            "Test-NodeSqliteSupported",
            "Check-Node",
            "Install-GitLauncher",
            "Test-PreviousGitWrapper",
            "Complete-NpmShimBackup",
          ].map(
            (name) => `function ${name} {\n${harness.extractFunctionBody(harness.source, name)}\n}`,
          ),
          `$env:USERPROFILE = ${harness.quote(join(root, "profile é ^caret^ %PERCENT% !bang!"))}`,
          `$node = ${harness.quote(process.execPath)}`,
          `$entry = ${harness.quote(entry)}`,
          String.raw`
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function Get-NpmCommandPath { return $null }
$homeBefore = $env:HOME
$wrapper = Join-Path $env:USERPROFILE '.local/bin/openclaw.cmd'
foreach ($mode in @('parent-help', 'unknown')) {
    [IO.File]::WriteAllText(($entry + '.mode'), $mode)
    if (-not (Install-GitLauncher -NodePath $node -EntryPath $entry)) { throw "retained $mode installation failed" }
    if (-not (Test-PreviousGitWrapper -EntryPath $entry -NodePath $node)) { throw 'retained launcher lost ownership or its validated runtime' }
    if ($env:HOME -cne $homeBefore) { throw 'HOME changed' }
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $version = (& $wrapper --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -cne 'retained-release-fixture') { throw 'retained launcher did not execute its selected CLI' }
    }
}
$working = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper))
[IO.File]::WriteAllText(($entry + '.mode'), 'broken')
if (Install-GitLauncher -NodePath $node -EntryPath $entry) { throw 'arbitrary CLI startup failure enabled compatibility' }
if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper)) -cne $working) { throw 'failed CLI damaged existing launcher' }
[IO.File]::WriteAllText(($entry + '.mode'), 'parent-help')
[IO.File]::WriteAllText($wrapper, '@echo foreign-owner')
if (Install-GitLauncher -NodePath $node -EntryPath $entry) { throw 'retained path replaced a foreign launcher' }
if ([IO.File]::ReadAllText($wrapper) -cne '@echo foreign-owner') { throw 'foreign launcher changed' }
[IO.File]::WriteAllText($wrapper, ('@echo off' + [Environment]::NewLine + 'node "C:\other\dist\entry.js" %*' + [Environment]::NewLine))
if (Install-GitLauncher -NodePath $node -EntryPath $entry) { throw 'retained path replaced another checkout launcher' }
if (@(Get-ChildItem -LiteralPath (Split-Path -Parent $wrapper) -Force).Count -ne 1) { throw 'retained publication leaked temporary output' }
# Publish a competing owner at the deterministic claimed-file validation boundary.
# The candidate must neither overwrite it nor delete the previous owner's recovery.
[IO.File]::WriteAllBytes($wrapper, [Convert]::FromBase64String($working))
$script:OriginalOwnerCheck = (Get-Command Test-PreviousGitWrapper).ScriptBlock
function Test-PreviousGitWrapper {
    param([string]$Path = $wrapper, [string]$EntryPath, [string]$NodePath)
    if ((Split-Path -Leaf $Path).StartsWith('.openclaw-launcher-recovery-')) {
        [IO.File]::WriteAllText($wrapper, '@echo concurrent-owner')
    }
    & $script:OriginalOwnerCheck -Path $Path -EntryPath $EntryPath -NodePath $NodePath
}
$refused = $false
try { Install-GitLauncher -NodePath $node -EntryPath $entry | Out-Null } catch { $refused = $_.Exception.Message.Contains('recovery retained') }
if (-not $refused -or [IO.File]::ReadAllText($wrapper) -cne '@echo concurrent-owner') { throw 'concurrent owner was overwritten or failure was hidden' }
$recovery = @(Get-ChildItem -LiteralPath (Split-Path -Parent $wrapper) -Filter '.openclaw-launcher-recovery-*' -Force)
if ($recovery.Count -ne 1 -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($recovery[0].FullName)) -cne $working) { throw 'previous owner recovery was lost' }
Remove-Item -LiteralPath $recovery[0].FullName -Force
if (@(Get-ChildItem -LiteralPath (Split-Path -Parent $wrapper) -Force).Count -ne 1) { throw 'concurrent publication leaked temporary output' }

`,
        ].join("\n"),
      );
      const result = harness.runPowerShell(["-NoLogo", "-NoProfile", "-File", script]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );
}
