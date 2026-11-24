import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runExec } from "../process/exec.js";
import type {
  ControlUiBrowserDiscovery,
  ControlUiBrowserInstallation,
} from "./control-ui-browser-discovery-types.js";
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
# Use the Shell association resolver, not the undocumented UserChoice registry layout.
# The opener receives handoff.html, so query its handler rather than assuming HTTPS
# and local HTML use the same application. This also honors UserChoiceLatest.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OpenClawBrowserAssociation {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int AssocQueryStringW(uint flags, uint str,
    string association, string extra, StringBuilder output, ref uint length);
  public static string HtmlExecutable() {
    // ASSOCF_NONE / ASSOCSTR_EXECUTABLE / default open verb. A fixed bound
    // avoids trusting the native returned length for an unbounded allocation.
    var output = new StringBuilder(32768);
    uint length = (uint)output.Capacity;
    return AssocQueryStringW(0, 2, ".html", "open", output, ref length) == 0
      ? output.ToString() : "";
  }
}
'@ -ErrorAction Stop
$defaultPath = [OpenClawBrowserAssociation]::HtmlExecutable()
$specs = ConvertFrom-Json '@BROWSERS@'
$items = @(
  foreach ($spec in $specs) {
    $paths = @(
      if ($defaultPath -and [IO.Path]::GetFileName($defaultPath) -ieq $spec.exe) { $defaultPath }
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
        @{family=$spec.family; path=$file.FullName; version=[string]$file.VersionInfo.ProductVersion}
      }
    }
  }
)
@{headless=(![Environment]::UserInteractive); defaultPath=$defaultPath; browsers=$items} | ConvertTo-Json -Depth 4 -Compress
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
    // Include bounded cold PowerShell/Add-Type startup without launching a browser.
    { timeoutMs: 5_000, maxBuffer: 64 * 1024, logOutput: false },
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
    if (
      typeof inventory.defaultPath === "string" &&
      executable.toLowerCase() === inventory.defaultPath.toLowerCase()
    ) {
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
