import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { extractFunctionBody } from "./install-ps1.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const SCRIPT_PATH = "scripts/install.ps1";
const ENTRYPOINT_RE = /\r?\n\$null = Main\r?\nComplete-Install\s*$/m;

function extractEntrypointLines(source: string): string[] {
  const match = source.match(ENTRYPOINT_RE);
  if (!match) {
    throw new Error("Missing PowerShell installer entrypoint");
  }
  return match[0].trim().split(/\r?\n/);
}

function findPowerShell(candidates = ["pwsh", "powershell"]): string | undefined {
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      {
        encoding: "utf8",
      },
    );
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

function toPowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createFailingNodeFixture(source: string): string {
  const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
  const entrypointLines = extractEntrypointLines(source);
  expect(scriptWithoutEntryPoint).not.toBe(source);

  return [
    scriptWithoutEntryPoint,
    "",
    "function Write-Banner { }",
    "function Ensure-ExecutionPolicy { return $true }",
    "function Check-Node { return $false }",
    "function Install-Node { return $false }",
    "",
    ...entrypointLines,
    "",
  ].join("\n");
}

function createDeferredPathSuccessFixture(source: string): string {
  const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
  const entrypointLines = extractEntrypointLines(source);
  expect(scriptWithoutEntryPoint).not.toBe(source);

  return [
    scriptWithoutEntryPoint,
    "",
    "function Write-Banner { }",
    "function Ensure-ExecutionPolicy { return $true }",
    "function Check-Node { return $true }",
    "function Check-ExistingOpenClaw { return $false }",
    "function Add-ToPath { param([string]$Path) }",
    "function Install-OpenClaw { return $true }",
    "function Ensure-OpenClawOnPath { return $false }",
    "$NoOnboard = $true",
    "",
    ...entrypointLines,
    "",
  ].join("\n");
}

describe("install.ps1 failure handling", () => {
  const harness = createScriptTestHarness();
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const powershell = findPowerShell();
  const bootstrapShells =
    process.platform === "win32"
      ? ["powershell", "pwsh"].filter((candidate) => findPowerShell([candidate]))
      : [];
  const runIfPowerShell = powershell ? it : it.skip;
  const runConcurrentIfPowerShell = powershell ? it.concurrent : it.skip;
  const runPowerShell = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return spawnSync(powershell, args, { encoding: "utf8" });
  };
  const runInstallerFile = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT_PATH, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
  };
  const runPowerShellAsync = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return new Promise<{ status: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(powershell, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stderr, stdout }));
      },
    );
  };
  const batchedPowerShellResults = new Map<string, { error: string; ok: boolean }>();

  beforeAll(() => {
    if (!powershell) {
      return;
    }
    const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
    const entrypointLines = extractEntrypointLines(source);
    const cases = [
      {
        name: "private-node-update",
        source: [
          scriptWithoutEntryPoint,
          String.raw`
$root = Join-Path $script:InstallerTempDirectory ('openclaw-private-node-test-' + [guid]::NewGuid().ToString('N'))
$NodeOnly = $true
$NodePrefix = Join-Path $root 'private tools/node'
$originalTemp = $script:InstallerTempDirectory
$beforePath = $env:PATH
$beforeUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$beforeMachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$script:InstallerTempDirectory = Join-Path $root 'temp'
$script:Scenario = ''
$script:Extractions = 0
function Check-ExistingOpenClaw { throw 'unexpected OpenClaw lookup' }
function Install-Node { throw 'unexpected package-manager install' }
function Install-OpenClaw { throw 'unexpected OpenClaw install' }
function Ensure-OpenClawOnPath { throw 'unexpected OpenClaw PATH update' }
function Add-ToProcessPath { throw 'unexpected process PATH update' }
function Add-ToUserPath { throw 'unexpected user PATH update' }
function Refresh-GatewayServiceIfLoaded { throw 'unexpected Gateway update' }
function Invoke-NpmCommand { throw 'unexpected npm invocation' }
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec)
    if ($Uri -ne 'https://nodejs.org/dist/index.json') { throw "unexpected metadata URL: $Uri" }
    return @([pscustomobject]@{ version = 'v26.1.0'; files = @('win-x64-zip', 'win-arm64-zip') })
}
function Save-InstallerDownload {
    param([string]$Uri, [string]$OutFile)
    if ($script:Scenario -eq 'download') { throw 'fixture download failure' }
    if ($Uri -eq 'https://nodejs.org/dist/v26.1.0/SHASUMS256.txt') {
        $archive = Get-ChildItem -LiteralPath (Split-Path -Parent $OutFile) -Filter '*.zip' | Select-Object -First 1
        $hash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash
        if ($script:Scenario -eq 'checksum') { $hash = '0' * 64 }
        $name = if ($script:Scenario -eq 'missing-checksum') { 'another-node.zip' } else { $archive.Name }
        [IO.File]::WriteAllText($OutFile, "$hash  $name")
        return
    }
    if ($Uri -notmatch '^https://nodejs\.org/dist/v26\.1\.0/node-v26\.1\.0-win-(x64|arm64)\.zip$') { throw "unexpected archive URL: $Uri" }
    [IO.File]::WriteAllText($OutFile, 'downloaded archive bytes')
}
function Expand-PortableNodeArchive {
    param([string]$ZipPath, [string]$DestinationPath)
    $script:Extractions++
    New-Item -ItemType Directory -Path $DestinationPath | Out-Null
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'node.exe'), 'new node')
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'npm.cmd'), 'matching npm')
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'npx.cmd'), 'matching npx')
    if ($script:Scenario -eq 'archive') { throw 'fixture extraction failure' }
}
function Check-Node {
    param([string]$NodePath)
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'runtime was not checked by its explicit path' }
    if ([IO.File]::ReadAllText($NodePath) -ne 'new node') { throw 'the downloaded runtime was not checked' }
    return ($script:Scenario -ne 'runtime')
}
try {
    New-Item -ItemType Directory -Force -Path $script:InstallerTempDirectory, $NodePrefix | Out-Null
    foreach ($scenario in @('download', 'checksum', 'missing-checksum', 'archive', 'runtime', 'success', 'fresh')) {
        $script:Scenario = $scenario
        $script:Extractions = 0
        $script:InstallExitCode = 0
        [IO.File]::WriteAllText((Join-Path $NodePrefix 'node.exe'), 'previous node')
        if ($scenario -eq 'fresh') { Remove-Item -LiteralPath $NodePrefix -Recurse -Force }
        $output = @(Main *>&1 | ForEach-Object { $_.ToString() })
        $success = $scenario -in @('success', 'fresh')
        if (($script:InstallExitCode -eq 0) -ne $success) { throw "incorrect result for $($scenario): $output" }
        $expectedExtractions = if ($scenario -in @('download', 'checksum', 'missing-checksum')) { 0 } else { 1 }
        if ($script:Extractions -ne $expectedExtractions) { throw "extraction boundary violated for $scenario" }
        $expectedNode = if ($success) { 'new node' } else { 'previous node' }
        if ([IO.File]::ReadAllText((Join-Path $NodePrefix 'node.exe')) -ne $expectedNode) { throw "previous runtime not preserved for $scenario" }
        if ($success) {
            if ([IO.File]::ReadAllText((Join-Path $NodePrefix 'npm.cmd')) -ne 'matching npm') { throw 'matching npm missing' }
            if ([IO.File]::ReadAllText((Join-Path $NodePrefix 'npx.cmd')) -ne 'matching npx') { throw 'matching npx missing' }
        }
        if (@(Get-ChildItem -LiteralPath $script:InstallerTempDirectory -Force).Count -ne 0) { throw 'download temporary files remain' }
        if (@(Get-ChildItem -LiteralPath (Split-Path -Parent $NodePrefix) -Force).Count -ne 1) { throw 'publication temporary directories remain' }
        if ($env:PATH -cne $beforePath) { throw 'process PATH changed' }
        if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $beforeUserPath) { throw 'user PATH changed' }
        if ([Environment]::GetEnvironmentVariable('Path', 'Machine') -cne $beforeMachinePath) { throw 'machine PATH changed' }
    }
} finally {
    $script:InstallerTempDirectory = $originalTemp
    Remove-Item -LiteralPath $root -Recurse -Force
}
`,
        ].join("\n"),
      },
      {
        name: "native-npm-stderr",
        source: [
          scriptWithoutEntryPoint,
          `$node = ${toPowerShellSingleQuotedLiteral(process.execPath)}`,
          String.raw`
$ErrorActionPreference = 'Stop'
$beforeLocation = (Get-Location).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('openclaw-native-stderr-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
$child = Join-Path $root 'child.cjs'
[IO.File]::WriteAllText($child, 'if (process.argv[2] === "marker") { require("node:fs").writeFileSync(process.argv[3], "spawned"); process.exit(0); } if (process.argv[2] === "warning") process.stderr.write("npm warn proof\n"); process.stdout.write("native-complete\n"); process.exit(Number(process.argv[3]));')
try {
    foreach ($wrapper in @('Invoke-NpmCommand', 'Invoke-CommandFromWindowsSafeDirectory')) {
        foreach ($stream in @('warning', 'quiet')) {
            foreach ($code in @(0, 17)) {
                $output = @(& $wrapper -CommandPath $node -Arguments @($child, $stream, [string]$code) -WorkingDirectory $root 2>&1)
                if ($LASTEXITCODE -ne $code) { throw "$wrapper changed native exit $code" }
                $text = ($output | ForEach-Object { $_.ToString() }) -join " "
                if (-not $text.Contains('native-complete')) { throw "$wrapper lost stdout" }
                if ($text.Contains('npm warn proof') -ne ($stream -eq 'warning')) { throw "$wrapper changed stderr" }
                if ($ErrorActionPreference -ne 'Stop' -or (Get-Location).Path -ne $beforeLocation) { throw "$wrapper leaked caller state" }
            }
        }
    }
    $marker = Join-Path $root 'unexpected-spawn'
    foreach ($entry in @(
        @{command=$node; directory=(Join-Path $root 'missing')},
        @{command=(Join-Path $root 'missing.exe'); directory=$root}
    )) {
        $caught = $false
        try { Invoke-NpmCommand -CommandPath $entry.command -Arguments @($child, 'marker', $marker) -WorkingDirectory $entry.directory 2>&1 | Out-Null } catch { $caught = $true }
        if (-not $caught -or (Test-Path -LiteralPath $marker)) { throw 'PowerShell setup failure did not stop the child' }
        if ($ErrorActionPreference -ne 'Stop' -or (Get-Location).Path -ne $beforeLocation) { throw 'PowerShell failure leaked caller state' }
    }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
`,
        ].join("\n"),
      },
      {
        name: "openclaw-native-command-exit",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-OpenClawCommandPath { return (Get-Process -Id $PID).Path }",
          "$caught = $false",
          "try {",
          "  Invoke-OpenClawCommand -NoLogo -NoProfile -Command 'exit 17'",
          "} catch {",
          "  if ($_.Exception.Message -notmatch 'failed with exit code 17') { throw }",
          "  $caught = $true",
          "}",
          "if (-not $caught) { throw 'nonzero native exit was accepted' }",
          "",
        ].join("\n"),
      },
      {
        name: "doctor-failure-output",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Invoke-OpenClawCommand { throw 'doctor failed' }",
          "$output = @(Run-Doctor *>&1 | ForEach-Object { $_.ToString() })",
          '$text = $output -join "`n"',
          "if ($text -match 'Migration complete') { throw 'doctor failure reported success' }",
          "if ($text -notmatch 'Migration failed') { throw \"missing error: $text\" }",
          "if ($output[-1] -ne $false) { throw 'doctor failure did not propagate' }",
          "",
        ].join("\n"),
      },
      {
        name: "npm-lifecycle-policy",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$script:NpmVersion = ''",
          "function Invoke-NpmCommand {",
          "  param([string[]]$Arguments = @(), [string]$CommandPath, [string]$WorkingDirectory)",
          "  if ($Arguments[0] -eq '--version') { Write-Output $script:NpmVersion; $global:LASTEXITCODE = 0; return }",
          "  throw 'unexpected npm mutation'",
          "}",
          "$cases = @{ '11.15.0' = $null; '11.16.0' = '--allow-scripts=openclaw'; '12.0.0' = '--allow-scripts=openclaw' }",
          "foreach ($entry in $cases.GetEnumerator()) {",
          "  $script:NpmVersion = $entry.Key",
          "  $actual = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'openclaw@latest'",
          '  if ($actual -ne $entry.Value) { throw "version=$($entry.Key) actual=$actual" }',
          "}",
          "$script:NpmVersion = '12.0.0'",
          "$tool = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'pnpm@12.0.0' -ExactIdentity 'pnpm@12.0.0'",
          'if ($tool -ne "--allow-scripts=pnpm@12.0.0") { throw "tool=$tool" }',
          "$alias = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'openclaw@npm:@scope/candidate@1.0.0'",
          "if ($alias -ne '--allow-scripts=@scope/candidate') { throw \"alias=$alias\" }",
          "$archiveAlias = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'openclaw@npm:@scope/candidate.tgz@1.0.0'",
          "if ($archiveAlias -ne '--allow-scripts=@scope/candidate.tgz') { throw \"alias=$archiveAlias\" }",
          "$tarball = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'https://example.invalid/openclaw.tgz'",
          "if ($tarball -ne '--allow-scripts=https://example.invalid/openclaw.tgz') { throw \"tarball=$tarball\" }",
          '$archiveRoot = Join-Path ([System.IO.Path]::GetTempPath()) "openclaw-archive-identity"',
          '$safeCwd = Join-Path $archiveRoot "work"',
          '$candidate = Join-Path $archiveRoot "candidate.tgz"',
          '$archiveUrl = "file:///" + $candidate.Replace("\\", "/").TrimStart("/")',
          'foreach ($spec in @($candidate, "../candidate.tgz", "file:$candidate", "file:../candidate.tgz", "file:/../candidate.tgz", "file:///../candidate.tgz", $archiveUrl)) {',
          '  $protocol = if ($spec.StartsWith("file:")) { "file:" } else { "" }',
          "  $actual = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec $spec -NpmCwd $safeCwd",
          '  if ($actual -ne "--allow-scripts=$protocol$candidate") { throw "archive=$actual" }',
          "}",
          '$commaRoot = Join-Path ([System.IO.Path]::GetTempPath()) "openclaw,identity"',
          "$caught = $false",
          "try { Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec (Join-Path $commaRoot 'candidate.tgz') -NpmCwd $commaRoot } catch {",
          "  if ($_.Exception.Message -notmatch 'without commas') { throw }",
          "  $caught = $true",
          "}",
          "if (-not $caught) { throw 'comma archive policy was accepted' }",
          "$script:NpmVersion = '11.16.0'",
          "$legacy = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec (Join-Path $commaRoot 'candidate.tgz') -NpmCwd $commaRoot",
          "if ($legacy -notmatch '^--allow-scripts=\\.[\\\\/]candidate\\.tgz$') { throw \"legacy=$legacy\" }",
          "$script:NpmVersion = '12.0.0'",
          '$safeCwd = Join-Path $commaRoot "safe"',
          '$candidate = Join-Path $commaRoot "candidate"',
          "$relative = Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec $candidate -NpmCwd $safeCwd",
          "if ($relative -match ',' -or $relative -notmatch '^--allow-scripts=\\.\\.[\\\\/]candidate$') { throw \"relative=$relative\" }",
          "foreach ($invalidVersion in @('invalid', 'npm 12.0.0 warning')) {",
          "  $script:NpmVersion = $invalidVersion",
          "  $caught = $false",
          "  try { Get-NpmLifecycleAllowArgument -NpmCommand 'npm.cmd' -InstallSpec 'openclaw@latest' } catch { $caught = $true }",
          '  if (-not $caught) { throw "invalid npm version was accepted: $invalidVersion" }',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "pnpm-prefer-offline-policy",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$root = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-pnpm-policy-" + [guid]::NewGuid().ToString("N"))',
          '$project = Join-Path $root "project"',
          "$previousUpper = $env:PNPM_CONFIG_PREFER_OFFLINE",
          "$previousLower = $env:pnpm_config_prefer_offline",
          "$script:PnpmConfigValue = 'undefined'",
          "function Get-TestPnpmConfig {",
          "  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)",
          "  if ($Arguments -join ' ' -ne 'config get prefer-offline') { throw \"unexpected pnpm command: $($Arguments -join ' ')\" }",
          '  if ((Get-Location).Path -ne $project) { throw "unexpected pnpm cwd: $(Get-Location)" }',
          "  if ($script:PnpmConfigValue -eq 'failure') { $global:LASTEXITCODE = 1; return }",
          "  $global:LASTEXITCODE = 0",
          "  return $script:PnpmConfigValue",
          "}",
          "try {",
          "  New-Item -ItemType Directory -Force -Path $project | Out-Null",
          "  Remove-Item Env:PNPM_CONFIG_PREFER_OFFLINE -ErrorAction SilentlyContinue",
          "  Remove-Item Env:pnpm_config_prefer_offline -ErrorAction SilentlyContinue",
          "  if (-not (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig')) { throw 'default was disabled' }",
          "  $script:PnpmConfigValue = 'false'",
          "  if (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig') { throw 'false pnpm config was ignored' }",
          "  $script:PnpmConfigValue = 'true'",
          "  if (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig') { throw 'true pnpm config was ignored' }",
          "  $script:PnpmConfigValue = 'failure'",
          "  if (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig') { throw 'failed pnpm config query enabled the default' }",
          "  $env:PNPM_CONFIG_PREFER_OFFLINE = 'false'",
          "  if (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig') { throw 'uppercase override was ignored' }",
          "  Remove-Item Env:PNPM_CONFIG_PREFER_OFFLINE -ErrorAction SilentlyContinue",
          "  $env:pnpm_config_prefer_offline = 'false'",
          "  if (Test-ShouldPreferOfflinePnpmInstall -ProjectDir $project -PnpmCommand 'Get-TestPnpmConfig') { throw 'lowercase override was ignored' }",
          "} finally {",
          "  $env:PNPM_CONFIG_PREFER_OFFLINE = $previousUpper",
          "  $env:pnpm_config_prefer_offline = $previousLower",
          "  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue",
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "npm-candidate-validation",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$root = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-missing-candidate-" + [guid]::NewGuid().ToString("N"))',
          "New-Item -ItemType Directory -Path $root | Out-Null",
          "function Check-ExistingOpenClaw { return $true }",
          "function Check-Node { return $true }",
          "function Ensure-Git { return $true }",
          "function Test-PreviousGitWrapper { return $false }",
          "function Get-NpmCommandPath { return 'npm.cmd' }",
          "function Get-WindowsCommandSafeDirectory { return $root }",
          "function Resolve-NpmOpenClawInstallSpec { return 'openclaw@latest' }",
          "function Test-NpmConfigRawKey { return $true }",
          "function Get-NpmDebugLogRootCandidates { return @() }",
          "function Invoke-NpmCommand {",
          "  param([string[]]$Arguments = @(), [string]$CommandPath, [string]$WorkingDirectory)",
          "  $global:LASTEXITCODE = 0",
          "  if ($Arguments[0] -eq '--version') { return '12.0.0' }",
          "  if ($Arguments[0] -eq 'root') { return $root }",
          "  if ($Arguments[0] -eq 'config') { return $root }",
          "  if ($Arguments[0] -eq 'install') { return }",
          "  throw \"unexpected npm command: $($Arguments -join ' ')\"",
          "}",
          "function Ensure-OpenClawOnPath { throw 'old PATH command was accepted after missing candidate' }",
          "$InstallMethod = 'npm'",
          "$NoOnboard = $true",
          "$Tag = 'latest'",
          "try {",
          "  $null = Main",
          '  if ($script:InstallExitCode -ne 1) { throw "InstallExitCode=$script:InstallExitCode" }',
          "} finally {",
          "  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue",
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "method-switch-preservation",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$script:OldOwnerRemoved = $false",
          "function Check-ExistingOpenClaw { return $true }",
          "function Check-Node { return $true }",
          "function Get-NpmCommandPath { return 'npm.cmd' }",
          "function Invoke-NpmCommand {",
          "  param([string[]]$Arguments = @(), [string]$CommandPath, [string]$WorkingDirectory)",
          "  if ($Arguments[0] -eq 'list') { $global:LASTEXITCODE = 0; return }",
          "  if ($Arguments[0] -eq 'uninstall') { $script:OldOwnerRemoved = $true; $global:LASTEXITCODE = 0; return }",
          "  throw 'unexpected npm command'",
          "}",
          "function Install-OpenClawFromGit { return $false }",
          "$InstallMethod = 'git'",
          "$NoOnboard = $true",
          "$null = Main",
          "if ($script:OldOwnerRemoved) { throw 'failed candidate retired the working npm owner' }",
          "",
        ].join("\n"),
      },
      {
        name: "node-versions",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$cases = @{",
          ...NODE_RELEASE_VERSION_CASES.map(
            (version) =>
              `  ${toPowerShellSingleQuotedLiteral(version)} = $${isSupportedOpenClawNodeVersion(version)}`,
          ),
          "}",
          "foreach ($entry in $cases.GetEnumerator()) {",
          "  $actual = Test-NodeVersionSupported -Version $entry.Key",
          '  if ($actual -ne $entry.Value) { throw "Version=$($entry.Key) Actual=$actual" }',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "node-capabilities",
        source: [
          scriptWithoutEntryPoint,
          "function Get-Command { [pscustomobject]@{ Source = 'Invoke-FixtureNode' } }",
          "function Invoke-FixtureNode {",
          "  $global:LASTEXITCODE = 0",
          "  if ($args[0] -eq '-v') { return $script:FixtureVersion }",
          "  $input | Out-Null",
          "  return $script:FixtureSqlite",
          "}",
          "foreach ($case in @(",
          "  @{ version = 'v24.19.0'; text = $true; expected = $true },",
          "  @{ version = 'v24.19.0'; text = $false; expected = $false },",
          "  @{ version = 'v24.15.0+vendor.1'; text = $true; expected = $false },",
          "  @{ version = 'v26.0.0+vendor.1'; text = $true; expected = $false },",
          "  @{ version = 'v24.15.0'; text = $false; expected = $false },",
          "  @{ version = 'v22.23.2'; text = $true; expected = $false }",
          ")) {",
          "  $script:FixtureVersion = $case.version",
          "  $script:FixtureSqlite = @{ available = $true; version = '3.51.3'; text = $case.text; blob = $true; json = $true } | ConvertTo-Json -Compress",
          "  $actual = Check-Node",
          '  if ($actual -ne $case.expected) { throw "Version=$($case.version) Text=$($case.text) Actual=$actual" }',
          "}",
        ].join("\n"),
      },
      {
        name: "same-prefix-shim-transaction",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$root = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-shim-transaction-" + [guid]::NewGuid().ToString("N"))',
          '$target = Join-Path $root "openclaw.cmd"',
          "try {",
          "  New-Item -ItemType Directory -Force -Path $root | Out-Null",
          '  $old = "@echo off`r`nnode `"C:\\old\\dist\\entry.js`" %*`r`n"',
          '  $launcher = Join-Path $root "node_modules\\openclaw\\openclaw.mjs"',
          '  $candidate = "@ECHO off`r`nGOTO start`r`n:find_dp0`r`nSET dp0=%~dp0`r`nEXIT /b`r`n:start`r`nSETLOCAL`r`nCALL :find_dp0`r`nnode `"%dp0%\\node_modules\\openclaw\\openclaw.mjs`" %*`r`n"',
          "  [System.IO.File]::WriteAllText($target, $old)",
          "  $backup = Start-NpmShimBackup -Path $target -ExpectedLauncher $launcher",
          "  [System.IO.File]::WriteAllText($target, $candidate)",
          "  Restore-NpmShimBackup -Backup $backup",
          "  if ([System.IO.File]::ReadAllText($target) -ne $old) { throw 'failure did not restore old wrapper' }",
          "  $backup = Start-NpmShimBackup -Path $target -ExpectedLauncher $launcher",
          "  [System.IO.File]::WriteAllText($target, $candidate)",
          "  Complete-NpmShimBackup -Backup $backup",
          "  if ([System.IO.File]::ReadAllText($target) -ne $candidate) { throw 'success did not retain npm shim' }",
          "  if (Test-Path -LiteralPath $backup.BackupPath) { throw 'committed backup remains' }",
          "  [System.IO.File]::WriteAllText($target, $old)",
          "  $backup = Start-NpmShimBackup -Path $target -ExpectedLauncher $launcher",
          '  [System.IO.File]::WriteAllText($target, "@echo off`r`necho unrelated`r`n")',
          "  $refused = $false",
          "  try { Restore-NpmShimBackup -Backup $backup } catch { $refused = $true }",
          "  if (-not $refused) { throw 'unrelated replacement was deleted' }",
          "  if ([System.IO.File]::ReadAllText($target) -notmatch 'unrelated') { throw 'unrelated replacement changed' }",
          "} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }",
          "",
        ].join("\n"),
      },
      {
        name: "canonical-temp-root",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$originalTemp = $env:TEMP",
          "$originalTmp = $env:TMP",
          '$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-install-temp-test-" + [guid]::NewGuid().ToString("N"))',
          '$longTemp = Join-Path $sandbox "Long Temp"',
          "try {",
          "  New-Item -ItemType Directory -Force -Path $longTemp | Out-Null",
          "  $env:TEMP = $longTemp",
          "  $env:TMP = $longTemp",
          "  $resolved = Resolve-InstallerTempDirectory",
          "  $expected = (Get-Item -LiteralPath $longTemp -ErrorAction Stop).FullName",
          '  if ($resolved -ne $expected) { throw "default=$resolved expected=$expected" }',
          "  $env:TEMP = '\\\\?\\' + $longTemp",
          "  $env:TMP = $env:TEMP",
          '  $resolved = Resolve-InstallerTempDirectory -LongPathResolver { param($candidate) if ($candidate -ne $longTemp) { throw "prefix not stripped: $candidate" }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName }',
          '  if ($resolved -ne $expected) { throw "extended=$resolved expected=$expected" }',
          "  # Windows PowerShell 5.1 proof: FSO Folder.Path echoes 8.3; Get-Item.FullName expands it.",
          "  $env:TEMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'",
          "  $env:TMP = $longTemp",
          "  $resolved = Resolve-InstallerTempDirectory -LongPathResolver { param($candidate) if ($candidate -match '~') { return $longTemp }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName }",
          '  if ($resolved -ne $longTemp) { throw "short=$resolved" }',
          "  $env:TEMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Missing'",
          "  $resolved = Resolve-InstallerTempDirectory -LongPathResolver { param($candidate) if ($candidate -match '~') { throw 'unresolvable short alias' }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName }",
          '  if ($resolved -ne $longTemp) { throw "fallback=$resolved" }',
          "  $env:TEMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'",
          "  $resolved = Resolve-InstallerTempDirectory -LongPathResolver { param($candidate) return $candidate }",
          '  if ($resolved -ne $longTemp) { throw "unchanged-short=$resolved" }',
          "  $env:TEMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'",
          "  Initialize-InstallerTempDirectory -LongPathResolver { param($candidate) if ($candidate -match '~') { return $longTemp }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName }",
          '  if ($script:InstallerTempDirectory -ne $longTemp) { throw "canonical=$script:InstallerTempDirectory" }',
          '  if ($env:TEMP -ne $longTemp) { throw "TEMP=$env:TEMP" }',
          '  if ($env:TMP -ne $longTemp) { throw "TMP=$env:TMP" }',
          "} finally {",
          "  $env:TEMP = $originalTemp",
          "  $env:TMP = $originalTmp",
          "  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }",
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "portable-git-layout",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-portable-git-test-" + [guid]::NewGuid().ToString("N"))',
          '$portableRoot = Join-Path $sandbox "portable-git"',
          "try {",
          "  New-Item -ItemType Directory -Force -Path $sandbox | Out-Null",
          "  $script:InstallerTempDirectory = $sandbox",
          "  function Get-PortableGitRoot { return $portableRoot }",
          "  function Resolve-PortableGitDownload { return @{ Tag = 'test'; Name = 'MinGit.zip'; Url = 'https://example.test/MinGit.zip' } }",
          "  function Ensure-PortableGitOnUserPath { }",
          "  function Use-PortableGitIfPresent { return (Test-Path -LiteralPath (Join-Path $portableRoot 'cmd/git.exe')) }",
          "  function Save-InstallerDownload {",
          "    param($Uri, $OutFile)",
          "    New-Item -ItemType File -Force -Path $OutFile | Out-Null",
          "  }",
          "  function Expand-Archive {",
          "    param($Path, $DestinationPath, [switch]$Force)",
          "    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationPath 'cmd') | Out-Null",
          "    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationPath 'etc') | Out-Null",
          "    New-Item -ItemType File -Force -Path (Join-Path $DestinationPath 'cmd/git.exe') | Out-Null",
          "    New-Item -ItemType File -Force -Path (Join-Path $DestinationPath 'etc/gitconfig') | Out-Null",
          "  }",
          "  Install-PortableGit",
          "  if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'cmd/git.exe'))) { throw 'missing cmd/git.exe' }",
          "  if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'etc/gitconfig'))) { throw 'missing etc/gitconfig' }",
          "  if (@(Get-ChildItem -LiteralPath $sandbox -Filter 'openclaw-portable-git-*').Count -ne 0) { throw 'temporary Git files remain' }",
          "} finally {",
          "  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }",
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "sqlite-versions",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function private-node-fixture {",
          "  $global:LASTEXITCODE = 0",
          "  if ($args[0] -eq '-v') { return 'v26.1.0' }",
          "  $input | Out-Null",
          "  return (@{ available = $true; version = $script:FixtureSqliteVersion; text = $true; blob = $true; json = $true } | ConvertTo-Json -Compress)",
          "}",
          "function Get-Command { throw 'unexpected ambient runtime lookup' }",
          "$cases = @{",
          "  '3.44.5' = $false",
          "  '3.44.6' = $true",
          "  '3.46.1' = $false",
          "  '3.50.6' = $false",
          "  '3.50.7' = $true",
          "  '3.51.2' = $false",
          "  '3.51.3' = $true",
          "  '3.53.1' = $true",
          "  'unavailable' = $false",
          "}",
          "foreach ($entry in $cases.GetEnumerator()) {",
          "  $actual = Test-NodeSqliteSupported -Version $entry.Key",
          '  if ($actual -ne $entry.Value) { throw "Version=$($entry.Key) Actual=$actual" }',
          "  $script:FixtureSqliteVersion = $entry.Key",
          "  $actual = Check-Node -NodePath 'private-node-fixture'",
          '  if ($actual -ne $entry.Value) { throw "Explicit runtime SQLite=$($entry.Key) Actual=$actual" }',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "native-arm64-git",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$env:PROCESSOR_ARCHITEW6432 = $null",
          "$env:PROCESSOR_ARCHITECTURE = 'ARM64'",
          "function Invoke-RestMethod {",
          "  param([string]$Uri, [object]$Headers, [int]$TimeoutSec)",
          '  if ($TimeoutSec -ne 300) { throw "TimeoutSec=$TimeoutSec" }',
          "  [pscustomobject]@{",
          "    tag_name = 'v2.54.0.windows.1'",
          "    assets = @(",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-64-bit.zip'; browser_download_url = 'https://example.test/x64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-arm64.zip'; browser_download_url = 'https://example.test/arm64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-busybox-64-bit.zip'; browser_download_url = 'https://example.test/busybox.zip' }",
          "    )",
          "  }",
          "}",
          "$download = Resolve-PortableGitDownload",
          "if ($download.Name -ne 'MinGit-2.54.0-arm64.zip') { throw \"Name=$($download.Name)\" }",
          "if ($download.Url -ne 'https://example.test/arm64.zip') { throw \"Url=$($download.Url)\" }",
          "",
        ].join("\n"),
      },
      {
        name: "emulated-arm64-downloads",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$env:PROCESSOR_ARCHITEW6432 = $null",
          "$env:PROCESSOR_ARCHITECTURE = 'AMD64'",
          "function Get-CimInstance {",
          "  [CmdletBinding()]",
          "  param([string]$ClassName)",
          "  if ($ClassName -eq 'Win32_Processor') { return [pscustomobject]@{ Architecture = 12; Name = 'Cobalt 100' } }",
          "  if ($ClassName -eq 'Win32_ComputerSystem') { return [pscustomobject]@{ SystemType = 'ARM64-based PC' } }",
          '  throw "Unexpected CIM class $ClassName"',
          "}",
          "function Invoke-RestMethod {",
          "  param([string]$Uri, [object]$Headers, [int]$OperationTimeoutSeconds)",
          '  if ($OperationTimeoutSeconds -ne 300) { throw "OperationTimeoutSeconds=$OperationTimeoutSeconds" }',
          "  if ($Uri -eq 'https://nodejs.org/dist/index.json') {",
          "    return @(",
          "      [pscustomobject]@{ version = 'v26.5.0'; files = @('win-arm64-zip', 'win-x64-zip') },",
          "      [pscustomobject]@{ version = 'v24.17.0'; files = @('win-arm64-zip', 'win-x64-zip') }",
          "    )",
          "  }",
          "  [pscustomobject]@{",
          "    tag_name = 'v2.54.0.windows.1'",
          "    assets = @(",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-64-bit.zip'; browser_download_url = 'https://example.test/x64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-arm64.zip'; browser_download_url = 'https://example.test/arm64.zip' }",
          "    )",
          "  }",
          "}",
          "$nodeDownload = Resolve-PortableNodeDownload",
          "if ($nodeDownload.Name -ne 'node-v26.5.0-win-arm64.zip') { throw \"NodeName=$($nodeDownload.Name)\" }",
          "$exactNode = Resolve-PortableNodeDownload -Version 24.17.0",
          "if ($exactNode.Name -ne 'node-v24.17.0-win-arm64.zip') { throw \"ExactNode=$($exactNode.Name)\" }",
          "$gitDownload = Resolve-PortableGitDownload",
          "if ($gitDownload.Name -ne 'MinGit-2.54.0-arm64.zip') { throw \"GitName=$($gitDownload.Name)\" }",
          "",
        ].join("\n"),
      },
      {
        name: "node-options",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--trace-warnings --max_old_space_size=8192" -MinOldSpaceMb 8192',
          'if ($result -ne "--trace-warnings --max-old-space-size=8192") { throw "alias result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max_old_space_size 8192 --trace-warnings" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=8192 --trace-warnings") { throw "split alias result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max-old-space-size=4096" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=8192") { throw "minimum result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "`"--max-old-space-size=12288`"" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=12288") { throw "quoted token result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max-old-space-size=`"12288`"" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=12288") { throw "quoted value result=$result" }',
          "",
        ].join("\n"),
      },
      {
        name: "winget-node-delayed-path",
        // Refresh-ProcessPath reads machine PATH, which may already contain the real Node install.
        source: [
          scriptWithoutEntryPoint,
          "",
          "$env:ProgramW6432 = 'C:\\openclaw-winget-test-' + [guid]::NewGuid().ToString('N')",
          '$env:ProgramFiles = "$env:ProgramW6432 (x86)"',
          '$script:wingetNodeDir = "$env:ProgramW6432\\nodejs"',
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'winget') { return $true }",
          "  return $null",
          "}",
          "function Join-Path {",
          "  param([string]$Path, [string]$ChildPath)",
          "  return \"$($Path.TrimEnd('\\'))\\$ChildPath\"",
          "}",
          "function Test-Path {",
          "  param([string]$Path)",
          '  return ($Path -eq "$script:wingetNodeDir\\node.exe")',
          "}",
          "filter Out-Host { }",
          "$env:Path = 'C:\\Windows\\System32'",
          "function winget {",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'winget output'",
          "}",
          "function Check-Node {",
          "  return (($env:Path -split ';') -contains $script:wingetNodeDir)",
          "}",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if (($env:Path -split ';')[0] -ne $script:wingetNodeDir) { throw \"Path=$env:Path\" }",
          "",
        ].join("\n"),
      },
      {
        name: "chocolatey-node-upgrade",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'choco') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "function choco {",
          "  $script:chocoArgs = $args -join ' '",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Chocolatey output'",
          "}",
          "function Check-Node { return $true }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if ($script:chocoArgs -ne 'upgrade nodejs-lts -y --install-if-not-installed') {",
          '  throw "Args=$script:chocoArgs"',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "scoop-node-update",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'scoop') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "$env:Path = 'C:\\session-bin'",
          "$script:scoopCalls = @()",
          "function scoop {",
          "  $script:scoopCalls += ($args -join ' ')",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Scoop output'",
          "}",
          "function Check-Node { return $true }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if (($script:scoopCalls -join '|') -ne 'update|install nodejs-lts|update nodejs-lts') {",
          "  throw \"Calls=$($script:scoopCalls -join '|')\"",
          "}",
          "if (($env:Path -split ';') -notcontains 'C:\\session-bin') { throw \"Path=$env:Path\" }",
          "",
        ].join("\n"),
      },
      {
        name: "package-manager-node-validation-failure",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'choco') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "function choco {",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Chocolatey output'",
          "}",
          "$script:portableCalled = $false",
          "function Install-PortableNode { $script:portableCalled = $true }",
          "function Check-Node { return $script:portableCalled }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if (-not $script:portableCalled) { throw 'Portable Node fallback was not attempted' }",
          "",
        ].join("\n"),
      },
      {
        name: "package-manager-node-command-failures",
        source: [
          scriptWithoutEntryPoint,
          String.raw`
function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -eq $script:manager) { return $true }
    return $null
}
filter Out-Host { }
function Invoke-FixtureManager {
    $script:attempts += 1
    Write-Output 'package-manager output must not become a success result'
    if ($script:failure -eq 'throw') { throw 'fixture package-manager failure' }
    $global:LASTEXITCODE = if ($script:failure -eq 'exit') { 17 } else { 0 }
}
function winget { Invoke-FixtureManager }
function choco { Invoke-FixtureManager }
function scoop { Invoke-FixtureManager }
function Refresh-ProcessPath { $script:refreshes += 1 }
function Add-InstalledNodeToProcessPath { $script:discoveries += 1; return $true }
function Check-Node { return $script:portableReady }
function Install-PortableNode { $script:portableCalls += 1; $script:portableReady = $true }
foreach ($script:manager in @('winget', 'choco', 'scoop')) {
    foreach ($script:failure in @('exit', 'throw', 'unsupported')) {
        $script:attempts = 0
        $script:refreshes = 0
        $script:discoveries = 0
        $script:portableCalls = 0
        $script:portableReady = $false
        $global:LASTEXITCODE = 0
        $result = @(Install-Node)
        if ($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]) {
            throw "manager=$script:manager failure=$script:failure result=$result"
        }
        $expectedAttempts = if ($script:manager -eq 'scoop' -and $script:failure -eq 'unsupported') { 3 } else { 1 }
        $expectedDiscoveries = if ($script:manager -eq 'winget') { 1 } else { 0 }
        if ($script:attempts -ne $expectedAttempts -or $script:refreshes -ne 1 -or $script:discoveries -ne $expectedDiscoveries -or $script:portableCalls -ne 1) {
            throw "unexpected recovery order/count: $script:manager $script:failure"
        }
        if ($ErrorActionPreference -ne 'Stop') { throw 'caller error policy changed' }
    }
}
`,
        ].join("\n"),
      },
      {
        name: "package-manager-node-next-manager-success",
        source: [
          scriptWithoutEntryPoint,
          String.raw`
$script:events = New-Object System.Collections.Generic.List[string]
$script:ready = $false
function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -in @('winget', 'choco', 'scoop')) { return $true }
    return $null
}
filter Out-Host { }
function winget { $script:events.Add('winget'); $global:LASTEXITCODE = 17; Write-Output 'winget failed' }
function choco { $script:events.Add('choco'); $global:LASTEXITCODE = 0; $script:ready = $true; Write-Output 'choco success' }
function scoop { throw 'Scoop must not run after supported Node is found' }
function Refresh-ProcessPath { $script:events.Add('refresh') }
function Add-InstalledNodeToProcessPath { $script:events.Add('discover'); return $false }
function Check-Node { $script:events.Add('check'); return $script:ready }
function Install-PortableNode { throw 'portable fallback must not run after supported Node is found' }
$result = @(Install-Node)
if ($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]) { throw "result=$result" }
if (($script:events -join '|') -ne 'winget|refresh|discover|check|choco|refresh|check') {
    throw "events=$($script:events -join '|')"
}
`,
        ].join("\n"),
      },
      {
        name: "package-manager-node-entrypoint-refusal",
        source: [
          scriptWithoutEntryPoint,
          String.raw`
$NodeOnly = $false
$NodePrefix = ''
$DryRun = $false
$InstallMethod = 'npm'
$NoOnboard = $true
function Check-ExistingOpenClaw { return $false }
function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -eq 'choco') { return $true }
    return $null
}
filter Out-Host { }
function choco { $global:LASTEXITCODE = 17; Write-Output 'fixture choco failure' }
function Refresh-ProcessPath { }
function Check-Node { return $false }
function Install-PortableNode {
    $script:portableCalls += 1
    if ($script:portableFailure -eq 'throw') { throw 'fixture portable failure' }
}
function Install-OpenClaw { throw 'package install must not run without a supported Node' }
foreach ($script:portableFailure in @('throw', 'unsupported')) {
    $script:InstallExitCode = 0
    $script:portableCalls = 0
    $caught = $false
    try {
`,
          ...entrypointLines.map((line) => `        ${line}`),
          String.raw`
    } catch {
        if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 1.') { throw }
        $caught = $true
    }
    if (-not $caught -or $script:InstallExitCode -ne 1 -or $script:portableCalls -ne 1) {
        throw 'failed recovery did not preserve the installer refusal contract'
    }
    if ($ErrorActionPreference -ne 'Stop') { throw 'caller error policy changed' }
}
`,
        ].join("\n"),
      },
      {
        name: "scriptblock-failure",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Write-Banner { }",
          "function Ensure-ExecutionPolicy { return $true }",
          "function Check-Node { return $false }",
          "function Install-Node { return $false }",
          "$caught = $false",
          "try {",
          ...entrypointLines.map((line) => `  ${line}`),
          "} catch {",
          "  if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 1.') { throw }",
          "  $caught = $true",
          "}",
          "if (-not $caught) { throw 'Install failure did not reach the caller' }",
          "",
        ].join("\n"),
      },
      {
        name: "scriptblock-deferred-path-success",
        source: createDeferredPathSuccessFixture(source),
      },
      {
        name: "noisy-git-failure",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Write-Banner { }",
          "function Ensure-ExecutionPolicy { return $true }",
          "function Check-Node { return $true }",
          "function Check-ExistingOpenClaw { return $false }",
          "function Get-NpmCommandPath { return $null }",
          "function Install-OpenClawFromGit {",
          "  Write-Output 'pnpm stdout before failure'",
          "  return $false",
          "}",
          "function Ensure-OpenClawOnPath { throw 'should not continue after failed git install' }",
          "$InstallMethod = 'git'",
          "$GitDir = 'C:\\\\openclaw-test'",
          "$NoOnboard = $true",
          "$null = Main",
          'if ($script:InstallExitCode -ne 1) { throw "InstallExitCode=$script:InstallExitCode" }',
          "",
        ].join("\n"),
      },
      {
        name: "quiet-main-success",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Write-Banner { }",
          "function Ensure-ExecutionPolicy { return $true }",
          "function Check-Node { return $true }",
          "function Check-ExistingOpenClaw { return $false }",
          "function Add-ToPath { param([string]$Path) }",
          "function Install-OpenClaw { Write-Output 'npm stdout'; return $true }",
          "function Ensure-OpenClawOnPath { return $true }",
          "function Refresh-GatewayServiceIfLoaded { }",
          "function Invoke-OpenClawCommand { return 'OpenClaw test-version' }",
          "$NoOnboard = $true",
          "$result = Main",
          "if ($result -is [array]) { throw 'Main returned an array' }",
          'if ($result -ne $true) { throw "Main returned $result" }',
          "",
        ].join("\n"),
      },
      {
        name: "terminal-code-success",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Write-Banner { }",
          "function Ensure-ExecutionPolicy { return $true }",
          "function Check-Node { return $true }",
          "function Check-ExistingOpenClaw { return $false }",
          "function Add-ToPath { param([string]$Path) }",
          "function Install-OpenClaw {",
          "  Write-Output 'native chatter'",
          "  return $true",
          "}",
          "function Ensure-OpenClawOnPath { return $true }",
          "function Refresh-GatewayServiceIfLoaded { }",
          "function Invoke-OpenClawCommand { return 'OpenClaw test-version' }",
          "$NoOnboard = $true",
          ...entrypointLines,
          "",
        ].join("\n"),
      },
      {
        name: "transactional-git-clone",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-transactional-clone-" + [guid]::NewGuid().ToString("N"))',
          "New-Item -ItemType Directory -Path $sandbox | Out-Null",
          "$script:CloneMode = 'success'",
          "$script:GitFilterSupport = $true",
          "$script:LastCloneArgs = @()",
          "$script:ConcurrentRepo = $null",
          "$script:AliasPath = $null",
          "$script:AliasReplacement = $null",
          "function git {",
          "  if ($args[0] -eq 'clone' -and $args[1] -eq '-h') {",
          "    if ($script:GitFilterSupport) { Write-Output '  --[no-]filter <args>' }",
          "    $global:LASTEXITCODE = 129",
          "    return",
          "  }",
          "  if ($args[0] -eq 'clone') { $script:LastCloneArgs = @($args) }",
          "  $target = $args[-1]",
          "  New-Item -ItemType Directory -Force -Path (Join-Path $target '.git') | Out-Null",
          "  Set-Content -LiteralPath (Join-Path $target 'checkout.marker') -Value 'complete'",
          "  if ($script:CloneMode -eq 'failure') { $global:LASTEXITCODE = 42; return }",
          "  if ($script:CloneMode -eq 'concurrent') {",
          "    New-Item -ItemType Directory -Path $script:ConcurrentRepo | Out-Null",
          "    Set-Content -LiteralPath (Join-Path $script:ConcurrentRepo 'user.marker') -Value 'keep'",
          "  }",
          "  if ($script:CloneMode -eq 'retarget-alias') {",
          "    Remove-Item -LiteralPath $script:AliasPath -Force",
          "    $linkType = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'Junction' } else { 'SymbolicLink' }",
          "    New-Item -ItemType $linkType -Path $script:AliasPath -Target $script:AliasReplacement | Out-Null",
          "  }",
          "  $global:LASTEXITCODE = 0",
          "}",
          "try {",
          "  $successRepo = Join-Path $sandbox 'success'",
          "  New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $successRepo",
          "  if (-not (Test-Path -LiteralPath (Join-Path $successRepo 'checkout.marker'))) { throw 'complete checkout was not published' }",
          "  if ($script:LastCloneArgs -notcontains '--filter=blob:none') { throw 'supported Git did not use a filtered clone' }",
          "",
          "  $emptyRepo = Join-Path $sandbox 'empty'",
          "  New-Item -ItemType Directory -Path $emptyRepo | Out-Null",
          "  $script:GitFilterSupport = $false",
          "  New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $emptyRepo",
          "  if (-not (Test-Path -LiteralPath (Join-Path $emptyRepo 'checkout.marker'))) { throw 'empty destination was not populated' }",
          "  if ($script:LastCloneArgs -contains '--filter=blob:none') { throw 'unsupported Git used a filtered clone' }",
          "",
          "  $aliasTarget = Join-Path $sandbox 'alias-target'",
          "  $script:AliasReplacement = Join-Path $sandbox 'alias-replacement'",
          "  $script:AliasPath = Join-Path $sandbox 'alias'",
          "  New-Item -ItemType Directory -Path $aliasTarget | Out-Null",
          "  New-Item -ItemType Directory -Path $script:AliasReplacement | Out-Null",
          "  $linkType = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'Junction' } else { 'SymbolicLink' }",
          "  New-Item -ItemType $linkType -Path $script:AliasPath -Target $aliasTarget | Out-Null",
          "  $script:CloneMode = 'retarget-alias'",
          "  New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $script:AliasPath",
          "  if (-not (Test-Path -LiteralPath (Join-Path $aliasTarget 'checkout.marker'))) { throw 'original alias target was not populated' }",
          "  if (@(Get-ChildItem -LiteralPath $script:AliasReplacement -Force).Count -ne 0) { throw 'replacement alias target was modified' }",
          "",
          "  $script:CloneMode = 'failure'",
          "  $failedRepo = Join-Path $sandbox 'failure'",
          "  $cloneFailed = $false",
          "  try { New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $failedRepo } catch { $cloneFailed = $true }",
          "  if (-not $cloneFailed) { throw 'failed clone was accepted' }",
          "  if (Test-Path -LiteralPath $failedRepo) { throw 'failed clone published its destination' }",
          "",
          "  $script:CloneMode = 'concurrent'",
          "  $script:ConcurrentRepo = Join-Path $sandbox 'concurrent'",
          "  $publicationFailed = $false",
          "  try { New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $script:ConcurrentRepo } catch { $publicationFailed = $true }",
          "  if (-not $publicationFailed) { throw 'concurrent destination was replaced' }",
          "  if ((Get-Content -LiteralPath (Join-Path $script:ConcurrentRepo 'user.marker') -Raw).Trim() -ne 'keep') { throw 'concurrent destination changed' }",
          "  if (Test-Path -LiteralPath (Join-Path $script:ConcurrentRepo 'checkout.marker')) { throw 'clone leaked into concurrent destination' }",
          "  if (@(Get-ChildItem -LiteralPath $sandbox -Filter '.openclaw-clone-*' -Force).Count -ne 0) { throw 'staging directories remain' }",
          "} finally {",
          "  Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue",
          "}",
          "",
        ].join("\n"),
      },
    ];
    if (process.platform === "win32") {
      cases.push({
        name: "pnpm-source-bootstrap-lifecycle",
        source: [
          scriptWithoutEntryPoint,
          `$nodeExe = ${toPowerShellSingleQuotedLiteral(process.execPath)}`,
          String.raw`
$root = Join-Path $script:InstallerTempDirectory ("openclaw pnpm boundary " + [guid]::NewGuid().ToString("N"))
$contextNames = @('COREPACK_ENABLE_DOWNLOAD_PROMPT', 'NPM_CONFIG_WORKSPACE_DIR', 'PNPM_CONFIG_LOCKFILE_DIR', 'PNPM_CONFIG_CHILD_CONCURRENCY', 'PNPM_CONFIG_NETWORK_CONCURRENCY', 'PNPM_CONFIG_WORKSPACE_CONCURRENCY', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'PNPM_CONFIG_SIDE_EFFECTS_CACHE', 'NODE_OPTIONS')
$saved = @{}
foreach ($name in (@('PATH', 'PATHEXT', 'USERPROFILE', 'OPENCLAW_TEST_BOOTSTRAP_ROOT', 'PNPM_CONFIG_PREFER_OFFLINE') + $contextNames)) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$previousTemp = $script:InstallerTempDirectory
$previousLocation = (Get-Location).Path
function Ensure-Git { return $true }
function Assert-GitCheckoutHasCommit { param([string]$RepoDir) }
function Remove-LegacySubmodule { param([string]$RepoDir) }
function git { throw 'unexpected Git mutation' }
function New-TransactionalGitCheckout { throw 'unexpected clone' }
function Main { throw 'unexpected installer entrypoint' }
function Run-Doctor { throw 'unexpected doctor' }
function Refresh-GatewayServiceIfLoaded { throw 'unexpected gateway refresh' }
function Invoke-OpenClawCommand { throw 'unexpected live CLI' }
function Publish-TextFileAtomically {
    param([string]$Path, [string]$Contents)
    $expectedPath = Join-Path $env:USERPROFILE '.local\bin\openclaw.cmd'
    # Duplicate separators can name the same Windows wrapper; require the exact normalized path.
    if ([IO.Path]::GetFullPath($Path) -ne [IO.Path]::GetFullPath($expectedPath)) { throw 'publication escaped fixture' }
    $script:Published += 1
}
function Add-ToUserPath { param([string]$Path); $script:PathPublished += 1; return $false }
$commandSource = @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.OPENCLAW_TEST_BOOTSTRAP_ROOT;
const spec = JSON.parse(fs.readFileSync(path.join(root, 'case.json'), 'utf8'));
const target = path.join(root, 'target');
const log = path.join(root, 'calls.jsonl');
const [kind, launcher, ...args] = process.argv.slice(2);
const samePath = (a, b) => assert.equal(path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase());
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
if (kind === 'verify') {
    const events = calls();
    assert.equal(events.some((e) => e.kind === 'ambient'), false, 'ambient pnpm ran');
    const stages = events.filter((e) => e.kind === 'selected' && e.args[0] !== '--version').map((e) => e.args[0]);
    const expected = spec.failure === 'bootstrap' || spec.failure === 'version' ? []
        : spec.failure === 'install' ? ['config', 'install', 'install']
        : spec.failure === 'build' ? ['config', 'install', 'ui:build', 'nested-ui', 'build']
        : ['config', 'install', 'ui:build', 'nested-ui', 'build', 'nested-build'];
    assert.deepEqual(stages, expected);
    const npmInstalls = events.filter((e) => e.kind === 'npm' && e.args[0] === 'install');
    assert.equal(npmInstalls.length, spec.mode === 'corepack' ? 0 : 1);
    assert.equal(events.filter((e) => e.kind === 'corepack').length, spec.mode === 'missing' ? 0 : 1);
    const selected = events.filter((e) => e.kind === 'selected');
    assert.ok(selected.length || spec.failure === 'bootstrap');
    for (const event of selected) {
        samePath(event.cwd, target);
        if (event.args[0] !== '--version') samePath(event.path.split(';')[0], path.dirname(event.launcher));
    }
    process.exit(0);
}
const roots = Object.fromEntries(['NPM_CONFIG_WORKSPACE_DIR', 'npm_config_workspace_dir', 'PNPM_CONFIG_LOCKFILE_DIR', 'pnpm_config_lockfile_dir'].map((key) => [key, process.env[key] ?? null]));
fs.appendFileSync(log, JSON.stringify({ kind, launcher, args, cwd: process.cwd(), path: process.env.PATH, roots, prompt: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null }) + '\n');
if (kind === 'ambient') {
    fs.writeFileSync(path.join(target, 'pnpm-lock.yaml'), 'corrupted');
    console.log(spec.version);
    process.exit(0);
}
assert.equal(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
for (const key of ['NPM_CONFIG_WORKSPACE_DIR', 'npm_config_workspace_dir', 'PNPM_CONFIG_LOCKFILE_DIR', 'pnpm_config_lockfile_dir']) {
    samePath(process.env[key], target);
}
for (const [key, value] of Object.entries({ CHILD_CONCURRENCY: '1', NETWORK_CONCURRENCY: '4', WORKSPACE_CONCURRENCY: '1', VERIFY_DEPS_BEFORE_RUN: 'false', SIDE_EFFECTS_CACHE: 'false' })) {
    assert.equal(process.env['PNPM_CONFIG_' + key], value, key);
}
const writeSelected = (dir) => {
    assert.equal(path.dirname(dir) === path.join(root, 'tools') || path.dirname(path.dirname(dir)) === path.join(root, 'tools'), true);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), '@echo off\r\n"' + process.execPath + '" "' + __filename + '" selected "%~f0" %*\r\nexit /b %errorlevel%\r\n');
};
if (kind === 'corepack') {
    assert.deepEqual(args.slice(0, 2), ['enable', '--install-directory']);
    assert.equal(args.length, 4);
    assert.equal(args[3], 'pnpm');
    samePath(path.dirname(args[2]), path.join(root, 'tools'));
    if (spec.mode === 'failing') process.exit(42);
    writeSelected(args[2]);
} else if (kind === 'npm') {
    if (args[0] === '--version') {
        assert.deepEqual(args, ['--version']);
        console.log('12.0.0');
    } else {
        assert.deepEqual(args.slice(0, 3), ['install', '-g', '--prefix']);
        assert.deepEqual(args.slice(4), ['pnpm@' + spec.version, '--allow-scripts=pnpm@' + spec.version]);
        assert.equal(path.basename(args[3]), 'npm');
        samePath(path.dirname(path.dirname(args[3])), path.join(root, 'tools'));
        if (spec.failure === 'bootstrap') process.exit(42);
        writeSelected(args[3]);
    }
} else {
    assert.equal(kind, 'selected');
    samePath(process.cwd(), target);
    if (args[0] === '--version') {
        assert.deepEqual(args, ['--version']);
        const wrongVersion = spec.failure === 'version' || (spec.mode === 'wrong-version' && path.basename(path.dirname(launcher)) !== 'npm');
        console.log(wrongVersion ? '0.0.0' : spec.version);
    } else if (args[0] === 'config') {
        assert.deepEqual(args, ['config', 'get', 'prefer-offline']);
        console.log('undefined');
    } else if (args[0] === 'install') {
        assert.deepEqual(args, ['install', '--prefer-offline', '--config.node-linker=hoisted', '--config.engine-strict=false', '--config.enable-pre-post-scripts=true', '--config.side-effects-cache=false', '--no-frozen-lockfile', '--config.child-concurrency=1', '--config.network-concurrency=4', '--config.workspace-concurrency=1']);
        if (spec.failure === 'install') process.exit(42);
    } else if (args[0] === 'ui:build' || args[0] === 'build') {
        assert.equal(args.length, 1);
        if (args[0] === 'build') {
            assert.match(process.env.NODE_OPTIONS, /--max-old-space-size=8192/);
            if (spec.failure === 'build') process.exit(42);
            fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(target, 'dist', 'entry.js'), 'process.exit(0);');
        }
        const child = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', 'pnpm ' + (args[0] === 'build' ? 'nested-build' : 'nested-ui')], { stdio: 'inherit', windowsVerbatimArguments: true });
        assert.equal(child.error, undefined);
        process.exit(child.status ?? 1);
    } else {
        assert.ok(['nested-ui', 'nested-build'].includes(args[0]));
        assert.equal(args.length, 1);
    }
}
'@
$scenarios = @(
    @{ Mode = 'corepack'; Failure = ''; Present = $true; Version = '12.0.0' },
    @{ Mode = 'corepack'; Failure = ''; Present = $false; Version = '11.15.1' },
    @{ Mode = 'missing'; Failure = ''; Present = $false; Version = '12.0.0' },
    @{ Mode = 'failing'; Failure = ''; Present = $true; Version = '12.0.0' },
    @{ Mode = 'wrong-version'; Failure = ''; Present = $false; Version = '12.0.0' },
    @{ Mode = 'missing'; Failure = 'bootstrap'; Present = $true; Version = '12.0.0' },
    @{ Mode = 'missing'; Failure = 'version'; Present = $false; Version = '12.0.0' },
    @{ Mode = 'corepack'; Failure = 'install'; Present = $false; Version = '12.0.0' },
    @{ Mode = 'missing'; Failure = 'build'; Present = $true; Version = '12.0.0' }
)
try {
    foreach ($scenario in $scenarios) {
        $caseRoot = Join-Path $root ([guid]::NewGuid().ToString('N'))
        $bin = Join-Path $caseRoot 'bin'
        $target = Join-Path $caseRoot 'target'
        $foreign = Join-Path $caseRoot 'foreign'
        $script:InstallerTempDirectory = Join-Path $caseRoot 'tools'
        foreach ($dir in @($bin, $target, $foreign, $script:InstallerTempDirectory)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $env:OPENCLAW_TEST_BOOTSTRAP_ROOT = $caseRoot
        $env:USERPROFILE = $caseRoot
        $env:PATH = $bin
        $env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
        $env:PNPM_CONFIG_PREFER_OFFLINE = $null
        [IO.File]::WriteAllText((Join-Path $caseRoot 'command.cjs'), $commandSource)
        $caseSpec = @{ mode = $scenario.Mode; failure = $scenario.Failure; version = $scenario.Version }
        [IO.File]::WriteAllText((Join-Path $caseRoot 'case.json'), ($caseSpec | ConvertTo-Json -Compress))
        [IO.File]::WriteAllText((Join-Path $target 'package.json'), ('{"packageManager":"pnpm@' + $scenario.Version + '"}'))
        foreach ($dir in @($target, $foreign)) { [IO.File]::WriteAllText((Join-Path $dir 'pnpm-lock.yaml'), 'unchanged') }
        $manifest = [IO.File]::ReadAllText((Join-Path $target 'package.json'))
        foreach ($kind in @('npm', 'ambient', 'corepack')) {
            if ($kind -eq 'corepack' -and $scenario.Mode -eq 'missing') { continue }
            $name = if ($kind -eq 'ambient') { 'pnpm' } else { $kind }
            $cmd = '@echo off' + [Environment]::NewLine + '"' + $nodeExe + '" "' + (Join-Path $caseRoot 'command.cjs') + '" ' + $kind + ' "%~f0" %*' + [Environment]::NewLine + 'exit /b %errorlevel%'
            [IO.File]::WriteAllText((Join-Path $bin ($name + '.cmd')), $cmd)
        }
        [IO.File]::WriteAllText((Join-Path $bin 'node.cmd'), ('@"' + $nodeExe + '" %*' + [Environment]::NewLine + '@exit /b %errorlevel%'))
        foreach ($name in $contextNames) {
            $value = if (-not $scenario.Present) { $null } elseif ($name -eq 'COREPACK_ENABLE_DOWNLOAD_PROMPT') { '1' } elseif ($name -eq 'NODE_OPTIONS') { '--no-warnings' } elseif ($name -match '_DIR$') { $foreign } else { '7' }
            Set-Item -LiteralPath "Env:$name" -Value $value
        }
        $caller = @{}
        foreach ($name in (@('PATH') + $contextNames)) { $caller[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        Set-Location -LiteralPath $foreign
        $script:Published = 0
        $script:PathPublished = 0
        $outsideRejected = try {
            Publish-TextFileAtomically -Path (Join-Path $caseRoot '..\openclaw.cmd') -Contents ''
            $false
        } catch {
            if ($_.Exception.Message -ne 'publication escaped fixture') { throw }
            $true
        }
        if (-not $outsideRejected -or $script:Published -ne 0) { throw 'outside publication was accepted' }
        $caught = $null
        $ownerOutput = @()
        try { $ownerOutput = @(Install-OpenClawFromGit -RepoDir $target -SkipUpdate) } catch { $caught = $_ }
        $success = Test-BooleanSuccessResult -Results $ownerOutput
        if ($scenario.Failure -in @('bootstrap', 'version')) {
            if (-not $caught -or $caught.Exception.Message -notmatch 'Could not (install|provision)') { throw "missing bootstrap failure: $caught" }
        } elseif ($caught) { throw $caught }
        $expectedSuccess = $scenario.Failure -eq ''
        if ($success -ne $expectedSuccess) { throw "unexpected owner result: $($scenario | ConvertTo-Json -Compress)" }
        if ($script:Published -ne [int]$expectedSuccess -or $script:PathPublished -ne [int]$expectedSuccess) { throw 'publication boundary was violated' }
        foreach ($name in $caller.Keys) {
            if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $caller[$name]) { throw "caller environment leaked: $name" }
        }
        if ((Get-Location).Path -ne $foreign) { throw 'caller location leaked' }
        if (@(Get-ChildItem -LiteralPath $script:InstallerTempDirectory -Force).Count -ne 0) { throw 'temporary pnpm prefix leaked' }
        foreach ($dir in @($target, $foreign)) {
            if ([IO.File]::ReadAllText((Join-Path $dir 'pnpm-lock.yaml')) -ne 'unchanged') { throw 'lockfile changed' }
        }
        if ([IO.File]::ReadAllText((Join-Path $target 'package.json')) -ne $manifest) { throw 'manifest changed' }
        & $nodeExe (Join-Path $caseRoot 'command.cjs') verify
        if ($LASTEXITCODE -ne 0) { throw "child boundary verification failed: $($scenario | ConvertTo-Json -Compress)" }
    }
} finally {
    Set-Location -LiteralPath $previousLocation
    foreach ($name in $saved.Keys) { Set-Item -LiteralPath "Env:$name" -Value $saved[$name] }
    $script:InstallerTempDirectory = $previousTemp
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
`,
        ].join("\n"),
      });
      cases.push({
        name: "portable-node-tar-fallback",
        source: [
          scriptWithoutEntryPoint,
          String.raw`
$root = Join-Path $script:InstallerTempDirectory ("openclaw portable node " + [guid]::NewGuid().ToString("N"))
$bin = Join-Path $root "bin"
$archiveRoot = Join-Path $root "archive"
$nodeRoot = Join-Path $archiveRoot "node-fixture"
$zip = Join-Path $root "node archive.zip"
$destination = Join-Path $root "portable node"
$tarArgsLog = Join-Path $root "tar-args.txt"
$previousPath = $env:PATH
$previousLocation = (Get-Location).Path
try {
    New-Item -ItemType Directory -Force -Path $bin, $nodeRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $nodeRoot "node.exe"), "node fixture bytes")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot, $zip)
    $tarScript = @(
        "@echo off",
        ('echo %~1 > "' + $tarArgsLog + '"'),
        ('echo %~2 >> "' + $tarArgsLog + '"'),
        ('echo %~3 >> "' + $tarArgsLog + '"'),
        ('echo %~4 >> "' + $tarArgsLog + '"'),
        ('echo %~5 >> "' + $tarArgsLog + '"'),
        ('echo %~6 >> "' + $tarArgsLog + '"'),
        'echo partial> "%~4\partial.marker"',
        "echo tar fixture failure 1>&2",
        "exit /b 17"
    )
    [IO.File]::WriteAllLines((Join-Path $bin "tar.cmd"), $tarScript)
    $env:PATH = "$bin;$env:PATH"
    # Explicit PowerShell redirection preserves the Windows PowerShell 5.1 failure mode.
    $output = @(Expand-PortableNodeArchive -ZipPath $zip -DestinationPath $destination 2>&1)
    if ($LASTEXITCODE -ne 17) { throw "native exit changed: $LASTEXITCODE" }
    $expectedArguments = @("-xf", $zip, "-C", $destination, "--strip-components", "1")
    $actualArguments = @(Get-Content -LiteralPath $tarArgsLog | ForEach-Object { $_.TrimEnd() })
    if (($actualArguments -join "|") -cne ($expectedArguments -join "|")) { throw "tar argument mismatch" }
    if ([IO.File]::ReadAllText((Join-Path $destination "node.exe")) -cne "node fixture bytes") { throw "fallback bytes changed" }
    if (Test-Path -LiteralPath (Join-Path $destination "partial.marker")) { throw "partial tar output remains" }
    if (@(Get-ChildItem -LiteralPath $root -Filter "portable-node-extract-*").Count -ne 0) { throw "fallback temporary directory remains" }
    if (($output | Out-String) -notmatch "tar fixture failure") { throw "native stderr lost" }
    if ($ErrorActionPreference -ne "Stop" -or (Get-Location).Path -ne $previousLocation) { throw "caller state leaked" }
} finally {
    $env:PATH = $previousPath
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
`,
        ].join("\n"),
      });
    }
    const tempDir = harness.createTempDir("openclaw-install-ps1-batch-");
    const fixtures = cases.map((testCase, index) => {
      const scriptPath = join(tempDir, `case-${index}.ps1`);
      writeFileSync(scriptPath, testCase.source);
      return { name: testCase.name, scriptPath };
    });
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$cases = @(",
      fixtures
        .map(
          (fixture) =>
            `  @{ Name = ${toPowerShellSingleQuotedLiteral(fixture.name)}; Path = ${toPowerShellSingleQuotedLiteral(fixture.scriptPath)} }`,
        )
        .join(",\n"),
      ")",
      "$results = foreach ($case in $cases) {",
      "  $caseOutput = New-Object System.Collections.Generic.List[string]",
      "  try {",
      "    & ([scriptblock]::Create((Get-Content -LiteralPath $case.Path -Raw))) *>&1 | ForEach-Object { $caseOutput.Add([string]$_) }",
      "    [pscustomobject]@{ name = $case.Name; ok = $true; error = '' }",
      "  } catch {",
      '    $details = ($caseOutput | Select-Object -Last 80) -join "`n"',
      '    [pscustomobject]@{ name = $case.Name; ok = $false; error = "$( $_.Exception.Message )`nNative exit: $LASTEXITCODE`n$details" }',
      "  }",
      "}",
      "$results | ConvertTo-Json -Compress",
    ].join("\n");
    const result = runPowerShell(["-NoLogo", "-NoProfile", "-Command", command]);
    if (result.status !== 0) {
      throw new Error(`PowerShell batch failed: ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout) as Array<{ error: string; name: string; ok: boolean }>;
    for (const entry of parsed) {
      batchedPowerShellResults.set(entry.name, { error: entry.error, ok: entry.ok });
    }
    // The hosted installer supports Windows PowerShell 5.1 as well as PowerShell 7.
    for (const engine of bootstrapShells) {
      if (engine === powershell) {
        continue;
      }
      for (const name of [
        "native-npm-stderr",
        "pnpm-source-bootstrap-lifecycle",
        "portable-git-layout",
        "portable-node-tar-fallback",
        "package-manager-node-command-failures",
        "package-manager-node-next-manager-success",
        "package-manager-node-entrypoint-refusal",
      ]) {
        const fixture = fixtures.find((entry) => entry.name === name);
        if (!fixture) {
          throw new Error(`Missing PowerShell fixture ${name}`);
        }
        const invocation = `$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Get-Content -LiteralPath ${toPowerShellSingleQuotedLiteral(fixture.scriptPath)} -Raw)))`;
        const engineResult = spawnSync(engine, ["-NoLogo", "-NoProfile", "-Command", invocation], {
          encoding: "utf8",
        });
        batchedPowerShellResults.set(`${name}:${engine}`, {
          ok: engineResult.status === 0,
          error:
            engineResult.status === 0
              ? ""
              : (engineResult.error?.message ?? engineResult.stdout + engineResult.stderr),
        });
      }
    }
  });

  function expectBatchedPowerShellCase(name: string): void {
    expect(batchedPowerShellResults.get(name)).toEqual({ error: "", ok: true });
  }

  runIfPowerShell(
    "renews legacy download watchdogs while bytes arrive and aborts stalled bodies",
    async () => {
      const server = http.createServer((request, response) => {
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/stream" });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("start");
        if (request.url === "/stall") {
          const timer = setTimeout(() => response.end("late"), 3000);
          response.once("close", () => clearTimeout(timer));
          return;
        }
        let chunks = 0;
        const timer = setInterval(() => {
          response.write(".");
          if (++chunks === 4) {
            response.end();
          }
        }, 400);
        response.once("close", () => clearInterval(timer));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Download fixture did not bind a TCP port");
        }
        const directory = harness.createTempDir("openclaw-installer-network-");
        const output = join(directory, "download.bin");
        const scriptPath = join(directory, "download.ps1");
        writeFileSync(
          scriptPath,
          [
            "$ErrorActionPreference = 'Stop'",
            "$script:UpdateNetworkTimeoutSeconds = 1",
            ...["Get-WebRequestTimeoutParameters", "Save-InstallerDownload"].map(
              (name) => `function ${name} {\n${extractFunctionBody(source, name)}}`,
            ),
            "function Invoke-WebRequest { throw 'Legacy downloads must stream directly' }",
            `$output = ${toPowerShellSingleQuotedLiteral(output)}`,
            `$base = 'http://127.0.0.1:${address.port}'`,
            'Save-InstallerDownload -Uri "$base/redirect" -OutFile $output',
            "if ([IO.File]::ReadAllText($output) -ne 'start....') { throw 'Incomplete slow download' }",
            "$failed = $false",
            'try { Save-InstallerDownload -Uri "$base/stall" -OutFile $output } catch { $failed = $true }',
            "if (-not $failed) { throw 'Stalled download was accepted' }",
            "$exclusive = [IO.File]::Open($output, 'Open', 'ReadWrite', 'None')",
            "$exclusive.Dispose()",
            "Write-Output 'slow-download-complete; stalled-download-aborted; file-released'",
          ].join("\n"),
        );
        const result = await runPowerShellAsync(["-NoLogo", "-NoProfile", "-File", scriptPath]);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "slow-download-complete; stalled-download-aborted; file-released",
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  runIfPowerShell("rejects unknown and positional options before starting the installer", () => {
    const cases = [
      ["-Frobnicate"],
      ["-DryRnu"],
      ["-NoOnbord"],
      ["-InstallMthod", "git"],
      ["-DryRun", "beta"],
      ["beta", "git"],
    ];

    for (const args of cases) {
      const result = runInstallerFile(args, {
        OPENCLAW_DRY_RUN: "1",
        OPENCLAW_NO_ONBOARD: "1",
      });
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("[OK] Windows detected");
    }
  });

  runIfPowerShell("validates environment options before starting the installer", () => {
    const result = runInstallerFile(["-NoOnboard"], {
      OPENCLAW_DRY_RUN: "1",
      OPENCLAW_INSTALL_METHOD: "bogus",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("[OK] Windows detected");
  });

  runIfPowerShell("shows help without starting the installer", () => {
    const fileResult = runInstallerFile(["-?"]);
    expect(fileResult.status).toBe(0);
    expect(`${fileResult.stdout}\n${fileResult.stderr}`).toContain("install.ps1");
    expect(`${fileResult.stdout}\n${fileResult.stderr}`).not.toContain("[OK] Windows detected");

    const scriptPath = toPowerShellSingleQuotedLiteral(join(process.cwd(), SCRIPT_PATH));
    const scriptblockResult = runPowerShell([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& ([scriptblock]::Create((Get-Content -LiteralPath ${scriptPath} -Raw))) -Help`,
    ]);
    expect(scriptblockResult.status).toBe(0);
    expect(scriptblockResult.stdout).toContain("Usage:");
    expect(scriptblockResult.stdout).toContain("-DryRun");
    expect(scriptblockResult.stdout).not.toContain("[OK] Windows detected");
  });

  runIfPowerShell("accepts the documented named options", () => {
    const result = runInstallerFile([
      "-DryRun",
      "-NoOnboard",
      "-InstallMethod",
      "git",
      "-NoGitUpdate",
      "-Tag",
      "main",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[OK] Install method: git");
    expect(result.stdout).toContain("[OK] Git update: disabled");
    expect(result.stdout).toContain("[OK] Onboard: skipped");
  });

  runIfPowerShell("requires an explicit absolute private prefix for Node-only updates", () => {
    const root = harness.createTempDir("openclaw-node-only-options-");
    for (const args of [
      ["-NodeOnly"],
      ["-NodeOnly", "-NodePrefix", "relative/node"],
      ["-NodeOnly", "-NodePrefix", parse(root).root],
      ["-NodePrefix", join(root, "private-node")],
    ]) {
      const result = runInstallerFile([...args, "-DryRun"]);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout).toContain("Error:");
    }
    const result = runInstallerFile([
      "-NodeOnly",
      "-NodePrefix",
      join(root, "private node"),
      "-DryRun",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PATH unchanged");
    expect(result.stdout).not.toContain("Install method:");
  });

  runIfPowerShell(
    "updates only the private runtime after checksum and compatibility checks",
    () => {
      expectBatchedPowerShellCase("private-node-update");
    },
  );

  runIfPowerShell("accepts only supported Node versions", () => {
    expectBatchedPowerShellCase("node-versions");
    expectBatchedPowerShellCase("sqlite-versions");
  });

  runIfPowerShell("requires the numeric floor and SQLite round trips before reusing Node", () => {
    expectBatchedPowerShellCase("node-capabilities");
  });

  runIfPowerShell("normalizes and exports one installer temp root", () => {
    expectBatchedPowerShellCase("canonical-temp-root");
  });

  runIfPowerShell("applies the canonical npm lifecycle version policy", () => {
    expectBatchedPowerShellCase("npm-lifecycle-policy");
  });

  runIfPowerShell(
    "preserves native stderr and exit codes without softening PowerShell failures",
    () => {
      if (process.platform === "win32") {
        expect(bootstrapShells).toContain("powershell");
      }
      expectBatchedPowerShellCase("native-npm-stderr");
      for (const engine of bootstrapShells) {
        if (engine !== powershell) {
          expectBatchedPowerShellCase(`native-npm-stderr:${engine}`);
        }
      }
    },
  );

  runIfPowerShell("preserves explicit pnpm prefer-offline settings for Git installs", () => {
    expectBatchedPowerShellCase("pnpm-prefer-offline-policy");
  });

  (process.platform === "win32" ? it : it.skip)(
    "scopes native pnpm children and restores the caller across source-install outcomes",
    () => {
      expect(bootstrapShells).toContain("powershell");
      for (const engine of bootstrapShells) {
        const name = "pnpm-source-bootstrap-lifecycle";
        expectBatchedPowerShellCase(engine === powershell ? name : `${name}:${engine}`);
      }
    },
  );

  (process.platform === "win32" ? it : it.skip)(
    "reaches portable Node ZIP fallback after redirected native tar stderr",
    () => {
      expect(bootstrapShells).toContain("powershell");
      for (const engine of bootstrapShells) {
        const name = "portable-node-tar-fallback";
        expectBatchedPowerShellCase(engine === powershell ? name : `${name}:${engine}`);
      }
    },
  );

  runIfPowerShell("rejects npm success without a usable candidate package", () => {
    expectBatchedPowerShellCase("npm-candidate-validation");
  });

  runIfPowerShell("preserves the npm owner when a git replacement fails", () => {
    expectBatchedPowerShellCase("method-switch-preservation");
  });

  runIfPowerShell("restores or commits the same-prefix npm shim transaction", () => {
    expectBatchedPowerShellCase("same-prefix-shim-transaction");
  });

  runIfPowerShell("installs portable Git from multiple archive roots without collisions", () => {
    if (process.platform === "win32") {
      expect(bootstrapShells).toContain("powershell");
    }
    expectBatchedPowerShellCase("portable-git-layout");
    for (const engine of bootstrapShells) {
      if (engine !== powershell) {
        expectBatchedPowerShellCase(`portable-git-layout:${engine}`);
      }
    }
  });

  runIfPowerShell("upgrades and validates Node installed by Windows package managers", () => {
    expectBatchedPowerShellCase("winget-node-delayed-path");
    expectBatchedPowerShellCase("chocolatey-node-upgrade");
    expectBatchedPowerShellCase("scoop-node-update");
    expectBatchedPowerShellCase("package-manager-node-validation-failure");
  });

  runIfPowerShell("recovers from package-manager failures and preserves installer refusal", () => {
    if (process.platform === "win32") {
      expect(bootstrapShells).toContain("powershell");
    }
    for (const name of [
      "package-manager-node-command-failures",
      "package-manager-node-next-manager-success",
      "package-manager-node-entrypoint-refusal",
    ]) {
      expectBatchedPowerShellCase(name);
      for (const engine of bootstrapShells) {
        if (engine !== powershell) {
          expectBatchedPowerShellCase(`${name}:${engine}`);
        }
      }
    }
  });

  runIfPowerShell("publishes fresh Git clones transactionally", () => {
    expectBatchedPowerShellCase("transactional-git-clone");
  });

  runIfPowerShell("selects native ARM64 MinGit when the release publishes it", () => {
    expectBatchedPowerShellCase("native-arm64-git");
  });

  runIfPowerShell("selects native ARM64 downloads when x64 PowerShell is emulated", () => {
    expectBatchedPowerShellCase("emulated-arm64-downloads");
  });

  runConcurrentIfPowerShell(
    "fails install when interactive onboarding exits non-zero",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
      const scriptPath = join(tempDir, "install.ps1");
      try {
        const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
        writeFileSync(
          scriptPath,
          [
            scriptWithoutEntryPoint,
            "",
            "function Write-Banner { }",
            "function Ensure-ExecutionPolicy { return $true }",
            "function Check-Node { return $true }",
            "function Check-ExistingOpenClaw { return $false }",
            "function Get-NpmCommandPath { return 'npm.cmd' }",
            "function Invoke-NpmCommand {",
            "  param([string[]]$Arguments = @(), [string]$CommandPath, [string]$WorkingDirectory)",
            "  if ($Arguments[0] -eq 'config' -and $Arguments[2] -eq 'prefix') { Write-Output $env:USERPROFILE; $global:LASTEXITCODE = 0; return }",
            "  throw 'unexpected npm command'",
            "}",
            "function Install-OpenClaw { return $true }",
            "function Ensure-OpenClawOnPath { return $true }",
            "function Add-ToUserPath { param([string]$Path) }",
            "function Get-OpenClawCommandPath { return 'cmd.exe' }",
            "function Start-Process {",
            "  param([string]$FilePath, [string[]]$ArgumentList, [switch]$NoNewWindow, [switch]$Wait, [switch]$PassThru)",
            "  [pscustomobject]@{ ExitCode = 17 }",
            "}",
            "$InstallMethod = 'npm'",
            "$NoOnboard = $false",
            "",
            ...extractEntrypointLines(source),
            "",
          ].join("\n"),
        );
        chmodSync(scriptPath, 0o755);

        const result = await runPowerShellAsync([
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ]);

        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "openclaw onboard failed with exit code 17",
        );
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  runConcurrentIfPowerShell("exits non-zero when run as a script file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
    const scriptPath = join(tempDir, "install.ps1");
    try {
      writeFileSync(scriptPath, createFailingNodeFixture(source));
      chmodSync(scriptPath, 0o755);

      const result = await runPowerShellAsync([
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ]);

      expect(result.status).toBe(1);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  runConcurrentIfPowerShell(
    "exits zero after install succeeds with deferred PATH discovery",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
      const scriptPath = join(tempDir, "install.ps1");
      try {
        writeFileSync(scriptPath, createDeferredPathSuccessFixture(source));
        chmodSync(scriptPath, 0o755);

        const result = await runPowerShellAsync([
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ]);

        expect(result.status).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("installation failed");
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  runIfPowerShell("throws without killing the caller when run as a scriptblock", () => {
    expectBatchedPowerShellCase("scriptblock-failure");
  });

  runIfPowerShell("accepts deferred PATH discovery when run as a scriptblock", () => {
    expectBatchedPowerShellCase("scriptblock-deferred-path-success");
  });

  runIfPowerShell("treats noisy Git install false as failure", () => {
    expectBatchedPowerShellCase("noisy-git-failure");
  });

  runIfPowerShell("preserves larger old-space NODE_OPTIONS aliases", () => {
    expectBatchedPowerShellCase("node-options");
  });

  runIfPowerShell("keeps npm chatter out of Main's success return value", () => {
    expectBatchedPowerShellCase("quiet-main-success");
  });

  runIfPowerShell("uses the terminal exit code when helper output precedes success", () => {
    expectBatchedPowerShellCase("terminal-code-success");
  });
});

describe("install.ps1 stale Winget repair", () => {
  const { createTempDir } = createScriptTestHarness();
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const powershell = findPowerShell();
  const runIfPowerShell = powershell ? it : it.skip;
  const cases = [
    {
      name: "repairs stale registration after a probe overwrites LASTEXITCODE",
      afterInstall: "text",
      afterRepair: "healthy",
      repair: true,
      success: true,
    },
    {
      name: "discovers Node after repairing a missing runtime",
      afterInstall: "missing",
      afterRepair: "healthy",
      repair: true,
      success: true,
    },
    {
      name: "accepts a normal successful install without repair",
      installExit: 0,
      afterInstall: "healthy",
      success: true,
    },
    {
      name: "accepts a healthy no-upgrade result without repair",
      afterInstall: "healthy",
      success: true,
    },
    { name: "does not repair generic Winget failure", installExit: 1 },
    { name: "does not repair another HRESULT", installExit: -1978335188 },
    { name: "does not repair successful install with missing Node", installExit: 0 },
    {
      name: "recovers unsupported repair through Chocolatey",
      repairExit: -1978335174,
      repair: true,
      fallback: "choco",
      success: true,
    },
    {
      name: "recovers failed repair through Scoop",
      repairExit: 1,
      repair: true,
      fallback: "scoop",
      success: true,
    },
    {
      name: "recovers unusable repair through portable Node",
      afterRepair: "old-sqlite",
      repair: true,
      fallback: "portable",
      success: true,
    },
    {
      name: "rejects unusable Chocolatey fallback after failed repair",
      repairExit: 1,
      repair: true,
      fallback: "choco",
      afterFallback: "old-sqlite",
    },
    {
      name: "rejects unusable portable fallback after failed repair",
      repairExit: 1,
      repair: true,
      fallback: "portable",
      afterFallback: "text",
    },
    {
      name: "recovers a generic Winget failure through portable Node",
      installExit: 1,
      fallback: "portable",
      success: true,
    },
    {
      name: "recovers a thrown Winget invocation through portable Node",
      installThrows: true,
      fallback: "portable",
      success: true,
    },
    {
      name: "recovers a generic Winget failure through the next package manager",
      installExit: 1,
      fallback: "choco",
      success: true,
    },
    {
      name: "rejects failed repair even if Node becomes healthy",
      repairExit: 1,
      afterRepair: "healthy",
      repair: true,
    },
    { name: "rejects repair that leaves Node missing", repair: true },
    { name: "rejects old Node after repair", afterRepair: "old-node", repair: true },
    { name: "rejects old SQLite after repair", afterRepair: "old-sqlite", repair: true },
    ...["text", "blob", "json", "probe-error"].map((capability) => ({
      name: `rejects broken SQLite ${capability} after repair`,
      afterRepair: capability,
      repair: true,
    })),
  ];

  runIfPowerShell.each(cases)("$name", (testCase) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    const fixtureNode = join(createTempDir("openclaw-winget-node-"), "node.ps1");
    writeFileSync(fixtureNode, "$input | Invoke-FixtureNode @args\n");
    const options = {
      installExit: -1978335189,
      repairExit: 0,
      afterInstall: "missing",
      afterRepair: "missing",
      repair: false,
      success: false,
      installThrows: false,
      fallback: "none",
      afterFallback: "healthy",
      ...testCase,
    };
    const functions = [
      "Fail-Install",
      "Test-BooleanSuccessResult",
      "Test-NodeVersionSupported",
      "Test-NodeSqliteSupported",
      "Check-Node",
      "Invoke-NodePackageManagerInstall",
      "Install-Node",
      "Main",
    ]
      .map((name) => `function ${name} {\n${extractFunctionBody(source, name)}}`)
      .join("\n");
    const fixture = [
      "$ErrorActionPreference = 'Stop'",
      `$fixtureNode = ${toPowerShellSingleQuotedLiteral(fixtureNode)}`,
      functions,
      `$case = ${toPowerShellSingleQuotedLiteral(JSON.stringify(options))} | ConvertFrom-Json`,
      String.raw`
function Reset-Fixture {
    $global:State = 'missing'
    $global:PendingState = 'missing'
    $global:Events = New-Object 'System.Collections.Generic.List[string]'
    $global:WingetCalls = New-Object 'System.Collections.Generic.List[object]'
    $global:Fallbacks = New-Object 'System.Collections.Generic.List[string]'
    $global:Messages = New-Object 'System.Collections.Generic.List[string]'
    $global:InstallExitCode = 0
    $global:Advanced = 0
    $global:ProbeCount = 0
    $global:LASTEXITCODE = 0
}
function Get-Command {
    [CmdletBinding()]
    param([string]$Name, [string]$CommandType)
    if ($Name -eq 'winget') { return $true }
    if ($Name -eq 'choco') { return ($case.fallback -eq 'choco') }
    if ($Name -eq 'scoop') { return ($case.fallback -eq 'scoop') }
    if ($Name -eq 'node') {
        $global:Events.Add("check:$global:State")
        if ($global:State -eq 'missing') { throw 'fixture Node is missing' }
        return [pscustomobject]@{ Source = $fixtureNode }
    }
    throw "unexpected command lookup: $Name"
}
function Invoke-FixtureNode {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '-v') {
        if ($global:State -eq 'old-node') { return 'v22.15.0' }
        return 'v26.1.0'
    }
    $probe = @($input) -join [Environment]::NewLine
    if (-not $probe.Contains('CREATE TABLE probe') -or -not $probe.Contains('a\u0000b\u0000')) {
        throw 'current SQLite capability probe was not executed'
    }
    $global:ProbeCount++
    if ($global:State -eq 'probe-error') { $global:LASTEXITCODE = 1; return }
    $version = if ($global:State -eq 'old-sqlite') { '3.50.6' } else { '3.51.3' }
    return (@{ available = $true; version = $version; text = ($global:State -ne 'text'); blob = ($global:State -ne 'blob'); json = ($global:State -ne 'json') } | ConvertTo-Json -Compress)
}
function winget {
    $global:Events.Add($args[0])
    $global:WingetCalls.Add(@($args))
    if ($args[0] -eq 'install') {
        if ($case.installThrows) { throw 'fixture Winget invocation failed' }
        $global:LASTEXITCODE = $case.installExit
        $global:PendingState = $case.afterInstall
    } elseif ($args[0] -eq 'repair') {
        $global:LASTEXITCODE = $case.repairExit
        $global:PendingState = $case.afterRepair
    } else { throw "unexpected Winget command: $args" }
    Write-Output 'native command output must not become a Boolean result'
}
function Refresh-ProcessPath { $global:Events.Add('refresh') }
function Add-InstalledNodeToProcessPath {
    $global:Events.Add('discover')
    $global:State = $global:PendingState
    return $true
}
function choco {
    $global:Fallbacks.Add('choco')
    $global:State = $case.afterFallback
    $global:LASTEXITCODE = 0
    Write-Output 'Chocolatey output must not become a Boolean result'
}
function scoop {
    $global:Fallbacks.Add("scoop:$($args -join ' ')")
    $global:State = $case.afterFallback
    $global:LASTEXITCODE = 0
    Write-Output 'Scoop output must not become a Boolean result'
}
function Write-Host { $global:Messages.Add(($args -join ' ')) }
function Install-PortableNode {
    $global:Fallbacks.Add('portable')
    if ($case.fallback -eq 'portable') { $global:State = $case.afterFallback; return }
    throw 'fixture portable recovery unavailable'
}
function Check-ExistingOpenClaw { return $false }
function Test-PreviousGitWrapper { return $false }
function Get-NpmCommandPath { return 'fixture-npm' }
function Get-WindowsCommandSafeDirectory { return $env:USERPROFILE }
function Invoke-NpmCommand { return $env:USERPROFILE }
function Install-OpenClaw { $global:Advanced++; return $true }
function Ensure-OpenClawOnPath { return $false }
function Refresh-GatewayServiceIfLoaded { throw 'unexpected service mutation' }
$env:USERPROFILE = [System.IO.Path]::GetTempPath()
$InstallMethod = 'npm'
Reset-Fixture
$result = @(Install-Node)
if ($result.Count -ne 1 -or $result[0] -isnot [bool]) { throw "Install-Node output leaked: $result" }
$direct = @{ success = $result[0]; events = $global:Events.ToArray(); calls = $global:WingetCalls.ToArray(); probes = $global:ProbeCount; fallbacks = $global:Fallbacks.ToArray(); messages = $global:Messages.ToArray() }
Reset-Fixture
$null = Main
$main = @{ advanced = $global:Advanced; exit = $global:InstallExitCode; events = $global:Events.ToArray(); calls = $global:WingetCalls.ToArray(); probes = $global:ProbeCount; fallbacks = $global:Fallbacks.ToArray(); messages = $global:Messages.ToArray() }
Reset-Fixture
$global:State = 'healthy'
$null = Main
$healthy = @{ advanced = $global:Advanced; calls = $global:WingetCalls.Count }
Write-Output ('RESULT:' + (@{ direct = $direct; main = $main; healthy = $healthy } | ConvertTo-Json -Depth 8 -Compress))
`,
    ].join("\n");
    const result = spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", fixture],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const line = result.stdout.split(/\r?\n/u).find((value) => value.startsWith("RESULT:"));
    expect(line, result.stdout).toBeDefined();
    const proof = JSON.parse(line!.slice("RESULT:".length));
    expect(proof.direct.success).toBe(options.success);
    expect(proof.main.advanced).toBe(options.success ? 1 : 0);
    expect(proof.main.exit).toBe(options.success ? 0 : 1);
    expect(proof.healthy).toEqual({ advanced: 1, calls: 0 });
    const installArgs = [
      "install",
      "OpenJS.NodeJS.LTS",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ];
    const repairArgs = [
      "repair",
      "--id",
      "OpenJS.NodeJS.LTS",
      "--exact",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ];
    for (const run of [proof.direct, proof.main]) {
      expect(run.calls).toEqual(options.repair ? [installArgs, repairArgs] : [installArgs]);
      const repaired =
        options.repair && options.repairExit === 0 && options.afterRepair === "healthy";
      const fallbackExpected =
        !repaired && (options.installThrows || options.afterInstall !== "healthy");
      const fallbacks: string[] = [];
      if (fallbackExpected) {
        if (options.fallback === "choco") {
          fallbacks.push("choco");
        } else if (options.fallback === "scoop") {
          fallbacks.push("scoop:update", "scoop:install nodejs-lts", "scoop:update nodejs-lts");
        }
        if (!["choco", "scoop"].includes(options.fallback) || options.afterFallback !== "healthy") {
          fallbacks.push("portable");
        }
      }
      expect(run.fallbacks).toEqual(fallbacks);
      expect(
        run.messages.filter((message: string) => message.includes("Node.js repaired via winget")),
      ).toHaveLength(repaired ? 1 : 0);
      const events = run === proof.main ? run.events.slice(1) : run.events;
      expect(events.slice(0, 4)).toEqual([
        "install",
        "refresh",
        "discover",
        `check:${options.afterInstall}`,
      ]);
      if (options.repair) {
        expect(events.slice(4, 7)).toEqual(["repair", "refresh", "discover"]);
      }
      if (options.success) {
        expect(events.at(-1)).toBe("check:healthy");
        expect(run.probes).toBeGreaterThan(0);
      }
    }
  });
});
