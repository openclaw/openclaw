import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { extractFunctionBody } from "./install-ps1.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const SCRIPT_PATH = "scripts/install.ps1";
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile"];
const source = readFileSync(SCRIPT_PATH, "utf8");
const ENTRYPOINT_RE = /\r?\n\$null = Main\r?\nComplete-Install\s*$/m;

function extractEntrypointLines(scriptSource: string): string[] {
  const match = scriptSource.match(ENTRYPOINT_RE);
  if (!match) {
    throw new Error("Missing PowerShell installer entrypoint");
  }
  return match[0].trim().split(/\r?\n/);
}

function findPowerShell(candidates = ["pwsh", "powershell"]): string | undefined {
  return candidates.find(
    (candidate) =>
      spawnSync(candidate, [...POWERSHELL_ARGS, "-Command", "$PSVersionTable.PSVersion"]).status ===
      0,
  );
}

const powershell = findPowerShell();

function runPowerShell(
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
  engine = powershell,
) {
  if (!engine) {
    throw new Error("PowerShell is not available");
  }
  return spawnSync(engine, [...POWERSHELL_ARGS, ...args], { ...options, encoding: "utf8" });
}

function installerFunctions(names: string[]): string {
  return names
    .map((name) => `function ${name} {\n${extractFunctionBody(source, name)}}`)
    .join("\n");
}

function toPowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createNativeUpgradeEnvironment(root: string, usableCommand: boolean): NodeJS.ProcessEnv {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const commandPath = join(root, "command.cjs");
  writeFileSync(
    commandPath,
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const [kind, ...args] = process.argv.slice(2);
const command = kind + " " + args.join(" ");
fs.appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ kind, args }) + "\n");
const outputs = {
  "git --version": "git version 2.50.0.windows.1",
  "npm --version": "11.15.0",
  "npm root -g": path.join(root, "prefix", "node_modules"),
  "openclaw daemon status --json": JSON.stringify({ service: { loaded: true } }),
  "openclaw --version": "2026.9.19",
};
if (Object.hasOwn(outputs, command)) {
  console.log(outputs[command]);
} else if (kind === "npm" && args[0] === "config" && args[1] === "get") {
  const values = { prefix: "prefix", cache: "cache", globalconfig: "npmrc" };
  console.log(Object.hasOwn(values, args[2]) ? path.join(root, values[args[2]]) : "undefined");
} else if (kind === "npm" && args[0] === "install" && args[1] === "-g") {
  const dist = path.join(root, "prefix", "node_modules", "openclaw", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "entry.js"), "// installed package\n");
  if (process.env.OPENCLAW_TEST_USABLE_COMMAND !== "1") fs.unlinkSync(path.join(root, "bin", "openclaw.cmd"));
} else if (!["openclaw gateway install --force", "openclaw gateway restart", "openclaw gateway status --json", "openclaw doctor --fix --non-interactive"].includes(command)) {
  throw new Error("Unexpected fixture command: " + command);
}
`,
  );
  for (const name of ["npm", "git", "openclaw"]) {
    writeFileSync(
      join(bin, `${name}.cmd`),
      `@echo off\r\n"%OPENCLAW_TEST_NODE%" "%~dp0..\\command.cjs" ${name} %*\r\nexit /b %errorlevel%\r\n`,
    );
  }
  writeFileSync(
    join(bin, "node.cmd"),
    '@echo off\r\n"%OPENCLAW_TEST_NODE%" %*\r\nexit /b %errorlevel%\r\n',
  );
  // Exercise native command discovery without ambient OpenClaw or npm configuration.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*|PNPM_.*|OPENCLAW_.*)$/i.test(
          key,
        ),
    ),
  );
  return {
    ...env,
    PATH: bin,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    HOME: root,
    USERPROFILE: root,
    TEMP: root,
    TMP: root,
    OPENCLAW_STATE_DIR: join(root, "state"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "npmrc"),
    NPM_CONFIG_CACHE: join(root, "cache"),
    OPENCLAW_TEST_NODE: process.execPath,
    OPENCLAW_TEST_USABLE_COMMAND: usableCommand ? "1" : "0",
  };
}

describe("install.ps1 failure handling", () => {
  const harness = createScriptTestHarness();
  const bootstrapShells =
    process.platform === "win32"
      ? ["powershell", "pwsh"].filter((candidate) => findPowerShell([candidate]))
      : [];
  const runIfPowerShell = powershell ? it : it.skip;
  const runConcurrentIfPowerShell = powershell ? it.concurrent : it.skip;
  const runInstallerFile = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    runPowerShell(["-NonInteractive", "-File", SCRIPT_PATH, ...args], {
      env: { ...process.env, ...env },
    });
  const runPowerShellAsync = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return new Promise<{ status: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(powershell, [...POWERSHELL_ARGS, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
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
  async function runFixtureFile(fixture: string) {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
    const scriptPath = join(tempDir, "install.ps1");
    try {
      writeFileSync(scriptPath, fixture);
      chmodSync(scriptPath, 0o755);
      return await runPowerShellAsync(["-ExecutionPolicy", "Bypass", "-File", scriptPath]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }

  const windowsOnlyFixtures = new Set([
    "pnpm-source-bootstrap-lifecycle",
    "portable-node-tar-fallback",
  ]);
  const legacyFixtureNames = [
    "native-npm-stderr",
    "pnpm-source-bootstrap-lifecycle",
    "portable-git-layout",
    "portable-node-tar-fallback",
    "package-manager-node-command-failures",
  ];
  const batchedPowerShellResults = new Map<string, { error: string; ok: boolean }>();

  const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
  const entrypointLines = extractEntrypointLines(source);
  const installerFixture = (...lines: string[]) =>
    [scriptWithoutEntryPoint, "", ...lines, ""].join("\n");
  const cases: Record<string, string> = {
    "private-node-update": installerFixture(
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
    return @([pscustomobject]@{ version = 'v26.12.1'; files = @('win-x64-zip', 'win-arm64-zip') })
}
function Save-InstallerDownload {
    param([string]$Uri, [string]$OutFile)
    if ($script:Scenario -eq 'download') { throw 'fixture download failure' }
    if ($Uri -eq 'https://nodejs.org/dist/v26.12.1/SHASUMS256.txt') {
        $archive = Get-ChildItem -LiteralPath (Split-Path -Parent $OutFile) -Filter '*.zip' | Select-Object -First 1
        $hash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash
        if ($script:Scenario -eq 'checksum') { $hash = '0' * 64 }
        $name = if ($script:Scenario -eq 'missing-checksum') { 'another-node.zip' } else { $archive.Name }
        [IO.File]::WriteAllText($OutFile, "$hash  $name")
        return
    }
    if ($Uri -notmatch '^https://nodejs\.org/dist/v26\.12\.1/node-v26\.12\.1-win-(x64|arm64)\.zip$') { throw "unexpected archive URL: $Uri" }
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
    ),
    "native-npm-stderr": installerFixture(
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
    ),
    "npm-lifecycle-policy": installerFixture(
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
    ),
    "pnpm-prefer-offline-policy": installerFixture(
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
    ),
    "npm-candidate-validation": installerFixture(
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
    ),
    "method-switch-preservation": installerFixture(
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
      "function Install-OpenClawFromGit { Write-Output 'pnpm stdout before failure'; return $false }",
      "function Ensure-OpenClawOnPath { throw 'should not continue after failed git install' }",
      "$InstallMethod = 'git'",
      "$NoOnboard = $true",
      "$null = Main",
      'if ($script:InstallExitCode -ne 1) { throw "InstallExitCode=$script:InstallExitCode" }',
      "if ($script:OldOwnerRemoved) { throw 'failed candidate retired the working npm owner' }",
    ),
    "node-versions": installerFixture(
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
    ),
    "target-node-engine": installerFixture(
      String.raw`
$cases = @(
  @('24.21.0', '>=24.22.1 <25 || >=26.12.1', $true),
  @('24.22.1', '>=24.22.1 <25 || >=26.12.1', $false),
  @('24.21.0', '>=24.16.0 <25 || >=26.1.0', $false),
  @('24.21.0', '', $true),
  @('26.12.0', '', $true),
  @('26.12.1', '', $false)
)
function Check-ExistingOpenClaw { return $false }
function Get-Command { return [pscustomobject]@{ Source = 'Invoke-FixtureNode' } }
function Invoke-FixtureNode {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq '-v') { return "v$script:fixtureVersion" }
  $input | Out-Null
  return '{"available":true,"version":"3.51.3","text":true,"blob":true,"json":true}'
}
function Invoke-NpmCommand {
  param([string[]]$Arguments)
  if (($Arguments -join ' ') -ne 'view openclaw@extended-stable engines.node --fetch-timeout=5000 --fetch-retries=0') { throw 'wrong target lookup' }
  $global:LASTEXITCODE = if ($script:fixtureEngine) { 0 } else { 1 }
  return $script:fixtureEngine
}
function Install-Node { $script:upgraded = $true; $script:fixtureVersion = '26.12.1'; return $true }
function Test-PreviousGitWrapper { throw 'package stage reached' }
$InstallMethod = 'npm'
$Tag = 'extended-stable'
foreach ($case in $cases) {
  $script:fixtureVersion = $case[0]; $script:fixtureEngine = $case[1]; $script:upgraded = $false
  try { Main; throw 'package stage missing' } catch {
    if ($_.Exception.Message -ne 'package stage reached') { throw }
  }
  if ($script:upgraded -ne $case[2]) { throw "Incorrect upgrade decision for $case" }
}
$Tag = 'beta'
$script:fixtureVersion = ''; $script:fixtureEngine = '>=26.13.0'
function Invoke-NpmCommand {
  param([string[]]$Arguments)
  if (-not $script:fixtureVersion) { throw 'npm is not provisioned yet' }
  if ($Arguments[1] -ne 'openclaw@beta') { throw 'beta target lost' }
  $global:LASTEXITCODE = 0
  return $script:fixtureEngine
}
function Fail-Install { throw 'incompatible beta runtime refused' }
try { Main; throw 'admission missing' } catch {
  if ($_.Exception.Message -ne 'incompatible beta runtime refused') { throw }
}
`,
    ),
    "git-target-node-engine": installerFixture(
      String.raw`
$root = Join-Path $script:InstallerTempDirectory 'git-engine'
$null = New-Item -ItemType Directory -Path (Join-Path $root '.git') -Force
function Check-ExistingOpenClaw { return $false }
function Ensure-Git { return $true }
function Assert-GitCheckoutHasCommit { }
function git { $global:LASTEXITCODE = 0 }
function Update-GitCheckoutBestEffort {
  Set-Content -LiteralPath (Join-Path $root 'package.json') -Value ('{"engines":{"node":"' + $script:fixtureEngine + '"}}')
}
function Get-Command { return [pscustomobject]@{ Source = 'Invoke-FixtureNode' } }
function Invoke-FixtureNode {
  if (-not (Test-Path (Join-Path $root 'package.json'))) { throw 'Node ran before checkout' }
  $global:LASTEXITCODE = 0
  if ($args[0] -eq '-v') { return "v$script:fixtureVersion" }
  $input | Out-Null
  return '{"available":true,"version":"3.51.3","text":true,"blob":true,"json":true}'
}
function Invoke-NpmCommand { throw 'npm ran before git build' }
function Install-Node { $script:upgraded = $true; $script:fixtureVersion = '26.12.1'; return $true }
function Ensure-Pnpm { throw 'git build reached' }
$InstallMethod = 'git'; $GitDir = $root
foreach ($case in @(
  @('>=24.16.0 <25 || >=26.1.0', $false),
  @('>=24.22.1 <25 || >=26.12.1', $true)
)) {
  Remove-Item -LiteralPath (Join-Path $root 'package.json') -ErrorAction SilentlyContinue
  $script:fixtureVersion = '24.21.0'; $script:fixtureEngine = $case[0]; $script:upgraded = $false
  try { Main; throw 'git build missing' } catch {
    if ($_.Exception.Message -ne 'git build reached') { throw }
  }
  if ($script:upgraded -ne $case[1]) { throw "Incorrect upgrade decision for $case" }
}
`,
    ),
    "node-capabilities": installerFixture(
      '$script:NodePackageEngine = ">=24.16.0 <25 || >=26.1.0"',
      `$cases = ${toPowerShellSingleQuotedLiteral(
        JSON.stringify([
          ["v24.22.1", "3.51.3", true, true],
          ["v24.22.1", "3.51.3", false, false],
          ["v24.16.0+vendor.1", "3.51.3", true, true],
          ["v26.1.0", "3.51.3", true, true],
          ["v24.16.0", "3.51.3", false, false],
          ["v24.15.0+vendor.1", "3.51.3", true, false],
          ["v26.0.0+vendor.1", "3.51.3", true, false],
          ["v24.15.0", "3.51.3", false, false],
          ["v22.23.2", "3.51.3", true, false],
          ...Object.entries({
            "3.44.5": false,
            "3.44.6": true,
            "3.46.1": false,
            "3.50.6": false,
            "3.50.7": true,
            "3.51.2": false,
            "3.51.3": true,
            "3.53.1": true,
            unavailable: false,
          }).map(([sqlite, expected]) => ["v26.12.1", sqlite, true, expected]),
        ]),
      )} | ConvertFrom-Json`,
      String.raw`
function Invoke-FixtureNode {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq '-v') { return $script:nodeCapabilityCase[0] }
  $input | Out-Null
  return (@{ available = $true; version = $script:nodeCapabilityCase[1]; text = $script:nodeCapabilityCase[2]; blob = $true; json = $true } | ConvertTo-Json -Compress)
}
function Get-Command {
  if ($script:explicit) { throw 'unexpected ambient runtime lookup' }
  return [pscustomobject]@{ Source = 'Invoke-FixtureNode' }
}
foreach ($script:nodeCapabilityCase in $cases) {
  $script:explicit = $script:nodeCapabilityCase[0] -eq 'v26.12.1'
  $actual = if ($script:explicit) { Check-Node -NodePath 'Invoke-FixtureNode' } else { Check-Node }
  if ($actual -ne $script:nodeCapabilityCase[3]) { throw "Node/SQLite case failed: $script:nodeCapabilityCase actual=$actual" }
}
`,
    ),
    "same-prefix-shim-transaction": installerFixture(
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
    ),
    "canonical-temp-root": installerFixture(
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
      "  $shortTemp = 'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp'",
      "  $env:TMP = $longTemp",
      "  foreach ($case in @(",
      "    @{ path = $shortTemp; resolve = { param($candidate) if ($candidate -match '~') { return $longTemp }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName } },",
      "    @{ path = 'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Missing'; resolve = { param($candidate) if ($candidate -match '~') { throw 'unresolvable short alias' }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName } },",
      "    @{ path = $shortTemp; resolve = { param($candidate) return $candidate } }",
      "  )) {",
      "    $env:TEMP = $case.path",
      "    $resolved = Resolve-InstallerTempDirectory -LongPathResolver $case.resolve",
      '    if ($resolved -ne $longTemp) { throw "short-path resolution=$resolved" }',
      "  }",
      "  $env:TEMP = $shortTemp",
      "  Initialize-InstallerTempDirectory -LongPathResolver { param($candidate) if ($candidate -match '~') { return $longTemp }; return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName }",
      '  if ($script:InstallerTempDirectory -ne $longTemp) { throw "canonical=$script:InstallerTempDirectory" }',
      '  if ($env:TEMP -ne $longTemp) { throw "TEMP=$env:TEMP" }',
      '  if ($env:TMP -ne $longTemp) { throw "TMP=$env:TMP" }',
      "} finally {",
      "  $env:TEMP = $originalTemp",
      "  $env:TMP = $originalTmp",
      "  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }",
      "}",
    ),
    "portable-git-layout": installerFixture(
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
    ),

    "native-arm64-git": installerFixture(
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
    ),
    "emulated-arm64-downloads": installerFixture(
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
    ),
    "node-options": installerFixture(
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
    ),
    // Refresh-ProcessPath reads machine PATH, which may already contain the real Node install.
    "winget-node-delayed-path": installerFixture(
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
      "$env:Path = 'C:\\session-bin'",
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
      "if (($env:Path -split ';') -notcontains 'C:\\session-bin') { throw \"Path=$env:Path\" }",
    ),
    "package-manager-node-command-failures": installerFixture(
      String.raw`
function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -eq $script:manager -or ($script:manager -eq 'all' -and $Name -in @('winget', 'choco', 'scoop'))) { return $true }
    return $null
}
filter Out-Host { }
function Invoke-FixtureManager {
    param([string]$Name)
    $script:attempts += 1
    $script:events.Add($Name)
    Write-Output 'package-manager output must not become a success result'
    if ($script:manager -eq 'all') {
        if ($Name -eq 'scoop') { throw 'Scoop must not run after supported Node is found' }
        $script:portableReady = $Name -eq 'choco'
        $global:LASTEXITCODE = if ($script:portableReady) { 0 } else { 17 }
        return
    }
    if ($script:failure -eq 'throw') { throw 'fixture package-manager failure' }
    $global:LASTEXITCODE = if ($script:failure -eq 'exit') { 17 } else { 0 }
}
function winget { Invoke-FixtureManager 'winget' }
function choco { Invoke-FixtureManager 'choco' }
function scoop { Invoke-FixtureManager 'scoop' }
function Refresh-ProcessPath { $script:refreshes += 1; $script:events.Add('refresh') }
function Add-InstalledNodeToProcessPath { $script:discoveries += 1; $script:events.Add('discover'); return ($script:manager -ne 'all') }
function Check-Node { $script:events.Add('check'); return $script:portableReady }
function Install-PortableNode {
    $script:portableCalls += 1
    if ($script:manager -eq 'all') { throw 'portable fallback must not run after supported Node is found' }
    if ($script:portableFailure -eq 'throw') { throw 'fixture portable failure' }
    $script:portableReady = $script:portableFailure -ne 'unsupported'
}
function Reset-ManagerFixture {
    $script:events = New-Object System.Collections.Generic.List[string]
    $script:attempts = $script:refreshes = $script:discoveries = $script:portableCalls = 0
    $script:portableReady = $false
    $script:portableFailure = ''
    $script:InstallExitCode = $global:LASTEXITCODE = 0
}
foreach ($script:manager in @('winget', 'choco', 'scoop')) {
    foreach ($script:failure in @('exit', 'throw', 'unsupported')) {
        Reset-ManagerFixture
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
Reset-ManagerFixture
$script:manager = 'all'
$result = @(Install-Node)
if ($result.Count -ne 1 -or $result[0] -isnot [bool] -or -not $result[0]) { throw "result=$result" }
if (($script:events -join '|') -ne 'winget|refresh|discover|check|choco|refresh|check') {
    throw "events=$($script:events -join '|')"
}
${installerFunctions(["Add-InstalledNodeToProcessPath"])}
Reset-ManagerFixture
$script:manager = 'choco'
$script:failure = 'exit'
$NodeOnly = $false
$NodePrefix = ''
$DryRun = $false
$InstallMethod = 'npm'
$NoOnboard = $true
function Check-ExistingOpenClaw { return $false }
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
    ),
    "quiet-main-success": installerFixture(
      "function Check-Node { return $true }",
      "function Check-ExistingOpenClaw { return $false }",
      "function Install-OpenClaw { Write-Output 'npm stdout'; return $true }",
      "function Ensure-OpenClawOnPath { return $true }",
      "function Refresh-GatewayServiceIfLoaded { }",
      "function Invoke-OpenClawCommand { return 'OpenClaw test-version' }",
      "$NoOnboard = $true",
      "$result = Main",
      "if ($result -is [array]) { throw 'Main returned an array' }",
      'if ($result -ne $true) { throw "Main returned $result" }',
      "Complete-Install",
    ),
    "transactional-git-clone": installerFixture(
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
      "  foreach ($empty in @($false, $true)) {",
      "    $repo = Join-Path $sandbox ([string]$empty)",
      "    if ($empty) { New-Item -ItemType Directory -Path $repo | Out-Null }",
      "    $script:GitFilterSupport = -not $empty",
      "    New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $repo",
      "    if (-not (Test-Path -LiteralPath (Join-Path $repo 'checkout.marker'))) { throw 'complete checkout was not published' }",
      "    if (($script:LastCloneArgs -contains '--filter=blob:none') -ne $script:GitFilterSupport) { throw 'incorrect clone filter selection' }",
      "  }",
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
      "  foreach ($mode in @('failure', 'concurrent')) {",
      "    $script:CloneMode = $mode",
      "    $repo = Join-Path $sandbox $mode",
      "    $script:ConcurrentRepo = $repo",
      "    $failed = $false",
      "    try { New-TransactionalGitCheckout -RepoUrl 'https://example.invalid/openclaw.git' -RepoDir $repo } catch { $failed = $true }",
      '    if (-not $failed) { throw "unexpected clone success: $mode" }',
      "    if ($mode -eq 'failure') {",
      "      if (Test-Path -LiteralPath $repo) { throw 'failed clone published its destination' }",
      "    } else {",
      "      if ((Get-Content -LiteralPath (Join-Path $repo 'user.marker') -Raw).Trim() -ne 'keep') { throw 'concurrent destination changed' }",
      "      if (Test-Path -LiteralPath (Join-Path $repo 'checkout.marker')) { throw 'clone leaked into concurrent destination' }",
      "    }",
      "  }",
      "  if (@(Get-ChildItem -LiteralPath $sandbox -Filter '.openclaw-clone-*' -Force).Count -ne 0) { throw 'staging directories remain' }",
      "} finally {",
      "  Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue",
      "}",
    ),
  };
  cases["pnpm-source-bootstrap-lifecycle"] = installerFixture(
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
fs.appendFileSync(log, JSON.stringify({ kind, launcher, args, cwd: process.cwd(), path: process.env.PATH }) + '\n');
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
        # This fixture stubs HEAD validation; declare its checkout metadata before package setup.
        New-Item -ItemType Directory -Path (Join-Path $target '.git') | Out-Null
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
  );
  cases["portable-node-tar-fallback"] = installerFixture(
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
  );
  beforeAll(() => {
    if (!powershell) {
      return;
    }
    const tempDir = harness.createTempDir("openclaw-install-ps1-batch-");
    const fixtures = Object.entries(cases)
      .filter(([name]) => process.platform === "win32" || !windowsOnlyFixtures.has(name))
      .map(([name, fixtureSource], index) => {
        const scriptPath = join(tempDir, `case-${index}.ps1`);
        writeFileSync(scriptPath, fixtureSource);
        return { name, scriptPath };
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
    const result = runPowerShell(["-Command", command]);
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
      for (const name of legacyFixtureNames) {
        const fixture = fixtures.find((entry) => entry.name === name);
        if (!fixture) {
          throw new Error(`Missing PowerShell fixture ${name}`);
        }
        const invocation = `$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Get-Content -LiteralPath ${toPowerShellSingleQuotedLiteral(fixture.scriptPath)} -Raw)))`;
        const engineResult = runPowerShell(["-Command", invocation], {}, engine);
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

  for (const name of Object.keys(cases)) {
    const test =
      windowsOnlyFixtures.has(name) && process.platform !== "win32" ? it.skip : runIfPowerShell;
    test(name, () => {
      expect(batchedPowerShellResults.get(name)).toEqual({ error: "", ok: true });
      if (legacyFixtureNames.includes(name) && process.platform === "win32") {
        expect(bootstrapShells).toContain("powershell");
        for (const engine of bootstrapShells.filter((candidate) => candidate !== powershell)) {
          expect(batchedPowerShellResults.get(`${name}:${engine}`)).toEqual({
            error: "",
            ok: true,
          });
        }
      }
    });
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
            installerFunctions(["Get-WebRequestTimeoutParameters", "Save-InstallerDownload"]),
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
        const result = await runPowerShellAsync(["-File", scriptPath]);
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
    const invalidArgs = [
      ["-Frobnicate"],
      ["-DryRnu"],
      ["-NoOnbord"],
      ["-InstallMthod", "git"],
      ["-DryRun", "beta"],
      ["beta", "git"],
    ];

    for (const args of invalidArgs) {
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

  runConcurrentIfPowerShell(
    "fails install when interactive onboarding exits non-zero",
    async () => {
      const result = await runFixtureFile(
        installerFixture(
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
          ...entrypointLines,
        ),
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "openclaw onboard failed with exit code 17",
      );
    },
  );

  runConcurrentIfPowerShell("exits non-zero when run as a script file", async () => {
    const result = await runFixtureFile(
      installerFixture(
        "function Check-Node { return $false }",
        "function Install-Node { return $false }",
        ...entrypointLines,
      ),
    );
    expect(result.status).toBe(1);
  });

  (process.platform === "win32" ? it : it.skip)(
    "reports native upgrade PATH failures without losing caller or service/Doctor ordering",
    () => {
      expect(bootstrapShells).toContain("powershell");
      for (const engine of bootstrapShells) {
        const resolved = runPowerShell(
          [
            "-Command",
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (Get-Process -Id $PID).Path",
          ],
          {},
          engine,
        );
        expect(resolved.status).toBe(0);
        const enginePath = resolved.stdout.trim();
        const runNative = (args: string[], root: string, usableCommand = true) =>
          runPowerShell(
            ["-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
            {
              env: createNativeUpgradeEnvironment(root, usableCommand),
              cwd: root,
              timeout: 60_000,
            },
            enginePath,
          );
        // Fail before Main can download Node or persist a user PATH change when
        // this test runner does not satisfy the installer's real prerequisites.
        const preflightRoot = harness.createTempDir("openclaw-native-node-é-");
        const preflightPath = join(preflightRoot, "check-node.ps1");
        writeFileSync(
          preflightPath,
          [
            "$ErrorActionPreference = 'Stop'",
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
            installerFunctions([
              "Test-NodeVersionSupported",
              "Test-NodePackageEngine",
              "Test-NodeSqliteSupported",
              "Check-Node",
            ]),
            "if (-not (Check-Node)) { exit 1 }",
          ].join("\n"),
        );
        const preflight = runNative(["-File", preflightPath], preflightRoot);
        const prerequisite = `${engine} requires usable Node/SQLite: ${preflight.stdout}\n${preflight.stderr}`;
        expect(preflight.error, prerequisite).toBeUndefined();
        expect(preflight.status, prerequisite).toBe(0);
        for (const usableCommand of [false, true]) {
          for (const mode of ["file", "scriptblock"]) {
            const root = harness.createTempDir("openclaw-native-upgrade-é-");
            const scriptPath = join(root, "install.ps1");
            writeFileSync(scriptPath, source);
            const command = [
              "try {",
              `  & ([scriptblock]::Create([IO.File]::ReadAllText(${toPowerShellSingleQuotedLiteral(scriptPath)}))) -InstallMethod npm -NoOnboard -Tag 2026.9.19`,
              "} catch {",
              "  if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 1.') { throw }",
              "  Write-Output 'CAUGHT_CANONICAL_INSTALL_FAILURE'",
              "}",
              "Write-Output 'INSTALL_CALLER_SURVIVED'",
            ].join("\n");
            // Node-backed fixture commands emit UTF-8. Configure only their caller's
            // decoder; invoking the unchanged .ps1 by path still sets PSCommandPath,
            // so Complete-Install must terminate this process on file failure.
            const invocation =
              mode === "file"
                ? `& ${toPowerShellSingleQuotedLiteral(scriptPath)} -InstallMethod npm -NoOnboard -Tag 2026.9.19`
                : command;
            const result = runNative(
              [
                "-Command",
                `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${invocation}`,
              ],
              root,
              usableCommand,
            );
            const output = `${result.stdout}\n${result.stderr}`;
            const label = `${engine} ${mode} usable=${usableCommand}: ${output}`;
            expect(result.error, label).toBeUndefined();
            expect(result.status, label).toBe(!usableCommand && mode === "file" ? 1 : 0);
            expect(output, label).toContain("Existing OpenClaw installation detected");
            expect(output, label).toContain("[OK] OpenClaw installed");
            const calls = readFileSync(join(root, "commands.jsonl"), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { kind: string; args: string[] });
            expect(
              calls.some((call) => call.kind === "npm" && call.args[0] === "install"),
              label,
            ).toBe(true);
            const cliCalls = calls
              .filter((call) => call.kind === "openclaw")
              .map((call) => call.args.join(" "));
            if (usableCommand) {
              expect(output, label).toContain("Upgrade complete.");
              expect(output, label).not.toContain("CAUGHT_CANONICAL_INSTALL_FAILURE");
              expect(cliCalls, label).toEqual([
                "daemon status --json",
                "gateway install --force",
                "gateway restart",
                "gateway status --json",
                "doctor --fix --non-interactive",
                "--version",
              ]);
            } else {
              expect(output, label).toContain(
                "OpenClaw was installed, but its command is not on PATH.",
              );
              expect(output, label).toContain("Open a new terminal, then run: openclaw doctor");
              expect(output, label).not.toContain("installed successfully");
              expect(output, label).not.toContain("Upgrade complete.");
              expect(cliCalls, label).toEqual([]);
              if (mode === "scriptblock") {
                expect(output, label).toContain("CAUGHT_CANONICAL_INSTALL_FAILURE");
              }
            }
            if (mode === "scriptblock") {
              expect(output, label).toContain("INSTALL_CALLER_SURVIVED");
            }
          }
        }
      }
    },
    120_000,
  );
});

describe("install.ps1 stale Winget repair", () => {
  const { createTempDir } = createScriptTestHarness();
  const runIfPowerShell = powershell ? it : it.skip;
  const defaults = {
    installExit: -1978335189,
    repairExit: 0,
    afterInstall: "missing",
    afterRepair: "missing",
    repair: true,
    success: false,
    fallback: "none",
    afterFallback: "healthy",
  };
  const cases: Record<string, Partial<typeof defaults>> = {
    "preserves exit code across probes": {
      afterInstall: "text",
      afterRepair: "healthy",
      success: true,
    },
    "repairs missing runtime": { afterRepair: "healthy", success: true },
    "accepts healthy no-upgrade": { afterInstall: "healthy", success: true, repair: false },
    "does not repair generic failure": { installExit: 1, repair: false },
    "does not repair successful install": { installExit: 0, repair: false },
    "falls back to Chocolatey": {
      repairExit: -1978335174,
      fallback: "choco",
      success: true,
    },
    "falls back to Scoop": { repairExit: 1, fallback: "scoop", success: true },
    "falls back from old SQLite": {
      afterRepair: "old-sqlite",
      fallback: "portable",
      success: true,
    },
    "rejects unusable fallback": {
      repairExit: 1,
      fallback: "portable",
      afterFallback: "text",
    },
    "rejects failed repair with healthy Node": {
      repairExit: 1,
      afterRepair: "healthy",
    },
    "rejects missing repaired Node": {},
    ...Object.fromEntries(
      ["text", "blob", "json", "probe-error"].map((capability) => [
        `rejects repaired SQLite ${capability}`,
        { afterRepair: capability },
      ]),
    ),
  };
  runIfPowerShell.each(Object.entries(cases))("%s", (_name, overrides) => {
    const fixtureNode = join(createTempDir("openclaw-winget-node-"), "node.ps1");
    writeFileSync(fixtureNode, "$input | Invoke-FixtureNode @args\n");
    const options = { ...defaults, ...overrides };
    const functions = installerFunctions([
      "Fail-Install",
      "Test-BooleanSuccessResult",
      "Test-NodeVersionSupported",
      "Test-NodePackageEngine",
      "Test-NodeSqliteSupported",
      "Check-Node",
      "Invoke-NodePackageManagerInstall",
      "Install-Node",
      "Resolve-NodePackageEngine",
      "Main",
      "Ensure-Node",
    ]);
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
        return 'v26.12.1'
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
    if (($args -join ' ') -ne 'upgrade nodejs-lts -y --install-if-not-installed') { throw "unexpected Chocolatey arguments: $args" }
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
function Ensure-OpenClawOnPath { return $true }
function Refresh-GatewayServiceIfLoaded { }
function Invoke-OpenClawCommand { return 'fixture-version' }
$NoOnboard = $true
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
    const result = runPowerShell(["-NonInteractive", "-Command", fixture]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const line = result.stdout.split(/\r?\n/u).find((value) => value.startsWith("RESULT:"));
    expect(line, result.stdout).toBeDefined();
    const proof = JSON.parse(line!.slice("RESULT:".length));
    expect(proof).toMatchObject({
      direct: { success: options.success },
      main: { advanced: options.success ? 1 : 0, exit: options.success ? 0 : 1 },
    });
    expect(proof.healthy).toEqual({ advanced: 1, calls: 0 });
    const agreements = [
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ];
    const installArgs = ["install", "OpenJS.NodeJS.LTS", ...agreements];
    const repairArgs = ["repair", "--id", "OpenJS.NodeJS.LTS", "--exact", ...agreements];
    for (const run of [proof.direct, proof.main]) {
      expect(run.calls).toEqual(options.repair ? [installArgs, repairArgs] : [installArgs]);
      const repaired =
        options.repair && options.repairExit === 0 && options.afterRepair === "healthy";
      const fallbackExpected = !repaired && options.afterInstall !== "healthy";
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
