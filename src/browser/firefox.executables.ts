import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserExecutable } from "./chrome.executables.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findFirstExecutable(candidates: Array<BrowserExecutable>): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

export function findFirefoxExecutableMac(): BrowserExecutable | null {
  const home = os.homedir();
  const candidates: Array<BrowserExecutable> = [
    {
      kind: "firefox",
      path: "/Applications/Firefox.app/Contents/MacOS/firefox",
    },
    {
      kind: "firefox",
      path: path.join(home, "Applications/Firefox.app/Contents/MacOS/firefox"),
    },
    {
      kind: "firefox-nightly",
      path: "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    },
    {
      kind: "firefox-nightly",
      path: path.join(home, "Applications/Firefox Nightly.app/Contents/MacOS/firefox"),
    },
    {
      kind: "firefox-dev",
      path: "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    },
    {
      kind: "firefox-dev",
      path: path.join(home, "Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"),
    },
  ];
  return findFirstExecutable(candidates);
}

export function findFirefoxExecutableLinux(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    { kind: "firefox", path: "/usr/bin/firefox" },
    { kind: "firefox", path: "/usr/bin/firefox-esr" },
    { kind: "firefox", path: "/snap/bin/firefox" },
    { kind: "firefox-dev", path: "/usr/bin/firefox-developer-edition" },
    { kind: "firefox-nightly", path: "/usr/bin/firefox-nightly" },
  ];
  return findFirstExecutable(candidates);
}

export function findFirefoxExecutableWindows(): BrowserExecutable | null {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const joinWin = path.win32.join;

  const candidates: Array<BrowserExecutable> = [
    {
      kind: "firefox",
      path: joinWin(programFiles, "Mozilla Firefox", "firefox.exe"),
    },
    {
      kind: "firefox",
      path: joinWin(programFilesX86, "Mozilla Firefox", "firefox.exe"),
    },
    {
      kind: "firefox-nightly",
      path: joinWin(programFiles, "Firefox Nightly", "firefox.exe"),
    },
    {
      kind: "firefox-nightly",
      path: joinWin(programFilesX86, "Firefox Nightly", "firefox.exe"),
    },
    {
      kind: "firefox-dev",
      path: joinWin(programFiles, "Firefox Developer Edition", "firefox.exe"),
    },
    {
      kind: "firefox-dev",
      path: joinWin(programFilesX86, "Firefox Developer Edition", "firefox.exe"),
    },
  ];
  return findFirstExecutable(candidates);
}

/**
 * Try to find Playwright's bundled (juggler-patched) Firefox.
 * Stock Firefox doesn't support Playwright's juggler protocol,
 * so we scan the Playwright browser cache for a compatible build.
 */
function findPlaywrightBundledFirefox(): BrowserExecutable | null {
  // Scan the Playwright cache directory for a bundled Firefox
  const cacheDir = playwrightCacheDir();
  if (!cacheDir) return null;

  try {
    const entries = fs
      .readdirSync(cacheDir)
      .filter((e: string) => e.startsWith("firefox-"))
      .sort()
      .reverse(); // newest first
    for (const entry of entries) {
      const candidates = [
        // macOS
        path.join(cacheDir, entry, "firefox", "Nightly.app", "Contents", "MacOS", "firefox"),
        // Linux
        path.join(cacheDir, entry, "firefox", "firefox"),
        // Windows
        path.join(cacheDir, entry, "firefox", "firefox.exe"),
      ];
      for (const candidate of candidates) {
        if (exists(candidate)) {
          return { kind: "firefox", path: candidate };
        }
      }
    }
  } catch {
    // cache dir not readable
  }
  return null;
}

function playwrightCacheDir(): string | null {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = os.homedir();
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  if (platform === "linux") {
    return path.join(home, ".cache", "ms-playwright");
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return path.join(localAppData, "ms-playwright");
  }
  return null;
}

/**
 * Resolve the Firefox executable for the given platform.
 * Prefers Playwright's bundled (juggler-patched) Firefox over system installs.
 * Returns null if no Firefox installation is found.
 */
export function resolveFirefoxExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  // Playwright's bundled Firefox has juggler support; prefer it
  const pw = findPlaywrightBundledFirefox();
  if (pw) return pw;

  if (platform === "darwin") {
    return findFirefoxExecutableMac();
  }
  if (platform === "linux") {
    return findFirefoxExecutableLinux();
  }
  if (platform === "win32") {
    return findFirefoxExecutableWindows();
  }
  return null;
}
