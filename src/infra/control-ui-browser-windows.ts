import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";
import type {
  ControlUiBrowserDiscovery,
  ControlUiBrowserInstallation,
} from "./control-ui-browser.js";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";

const BROWSERS = [
  {
    family: "chrome",
    name: "Chrome",
    exe: "chrome.exe",
    relative: "Google\\Chrome\\Application\\chrome.exe",
  },
  {
    family: "firefox",
    name: "Firefox",
    exe: "firefox.exe",
    relative: "Mozilla Firefox\\firefox.exe",
  },
  {
    family: "edge",
    name: "Edge",
    exe: "msedge.exe",
    relative: "Microsoft\\Edge\\Application\\msedge.exe",
  },
  {
    family: "ie",
    name: "Internet Explorer",
    exe: "iexplore.exe",
    relative: "Internet Explorer\\iexplore.exe",
  },
] as const;

// Read registrations and file versions only. Never execute registry shell commands or browsers.
const DISCOVER_WINDOWS_BROWSERS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$choice = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -Name ProgId
$family = switch -Regex ($choice) {
  '^ChromeHTML(?:[.-]|$)' { 'chrome'; break }
  '^FirefoxURL(?:[.-]|$)' { 'firefox'; break }
  '^MSEdgeHTM$' { 'edge'; break }
  '^IE\.HTTPS?$' { 'ie'; break }
}
$defaultPath = $null
if ($family) {
  foreach ($root in @('HKCU:\Software\Classes\', 'HKLM:\Software\Classes\')) {
    $key = Get-Item -LiteralPath ($root + $choice + '\shell\open\command')
    if ($key) {
      $command = $key.GetValue('')
      if ($command -match '^"([^"]+\.exe)"(?:\s|$)|^([^\s]+\.exe)(?:\s|$)') {
        $defaultPath = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        break
      }
    }
  }
}
$specs = ConvertFrom-Json '@BROWSERS@'
$items = @(
  foreach ($spec in $specs) {
    $paths = @(
      if ($family -eq $spec.family -and $defaultPath) { $defaultPath }
      foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\')) {
        $key = Get-Item -LiteralPath ($root + $spec.exe)
        if ($key) { $key.GetValue('') }
      }
      foreach ($root in @($env:ProgramFiles, [Environment]::GetFolderPath('ProgramFilesX86'), $env:LOCALAPPDATA)) {
        if ($root) { Join-Path $root $spec.relative }
      }
    )
    foreach ($candidate in ($paths | Select-Object -Unique)) {
      if (!$candidate -or [IO.Path]::GetFileName($candidate) -ine $spec.exe) { continue }
      $file = Get-Item -LiteralPath $candidate
      if ($file -and !$file.PSIsContainer) {
        @{family=$spec.family; path=$file.FullName; version=[string]$file.VersionInfo.ProductVersion;
          isDefault=($family -eq $spec.family -and $file.FullName -ieq $defaultPath)}
      }
    }
  }
)
@{headless=(![Environment]::UserInteractive); browsers=$items} | ConvertTo-Json -Depth 4 -Compress
`;

export async function discoverWindowsControlUiBrowsers(): Promise<ControlUiBrowserDiscovery> {
  const { stdout } = await runExec(
    getWindowsPowerShellExePath(process.env, performance.now() + 500),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      DISCOVER_WINDOWS_BROWSERS.replace("@BROWSERS@", JSON.stringify(BROWSERS)),
    ],
    { timeoutMs: 3_000, maxBuffer: 64 * 1024, logOutput: false },
  );
  const inventory: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (
    !isRecord(inventory) ||
    !Array.isArray(inventory.browsers) ||
    inventory.browsers.length > 32
  ) {
    return { alternatives: [] };
  }
  const alternatives: ControlUiBrowserInstallation[] = [];
  let defaultBrowser: ControlUiBrowserInstallation | undefined;
  for (const item of inventory.browsers) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.version !== "string" ||
      !/^[A-Za-z]:\\/.test(item.path) ||
      /[\r\n]/.test(item.path) ||
      item.path.includes("\0")
    ) {
      continue;
    }
    const executable = item.path;
    const spec = BROWSERS.find(
      (browser) =>
        browser.family === item.family &&
        browser.exe === path.win32.basename(executable).toLowerCase(),
    );
    if (!spec) {
      continue;
    }
    const browser: ControlUiBrowserInstallation = {
      family: spec.family,
      name: spec.name,
      version: item.version,
      command: [executable],
    };
    if (item.isDefault === true) {
      defaultBrowser = browser;
    }
    if (
      !alternatives.some(
        (existing) => existing.command[0]!.toLowerCase() === executable.toLowerCase(),
      )
    ) {
      alternatives.push(browser);
    }
  }
  alternatives.sort((a, b) => {
    const family =
      BROWSERS.findIndex((spec) => spec.family === a.family) -
      BROWSERS.findIndex((spec) => spec.family === b.family);
    return family || (a.command[0]!.toLowerCase() < b.command[0]!.toLowerCase() ? -1 : 1);
  });
  return { defaultBrowser, alternatives, headless: inventory.headless === true };
}
