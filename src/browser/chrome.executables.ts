import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedBrowserConfig } from "./config.js";

export type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findFirstExecutable(candidates: Array<BrowserExecutable>): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate;
  }

  return null;
}

export function findChromeExecutableMac(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    },
    {
      kind: "brave",
      path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
    {
      kind: "brave",
      path: path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    },
    {
      kind: "edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    {
      kind: "edge",
      path: path.join(os.homedir(), "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    },
    {
      kind: "chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      kind: "chromium",
      path: path.join(os.homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    },
    {
      kind: "canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
    {
      kind: "canary",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableLinux(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chrome", path: "/usr/bin/chrome" },
    { kind: "brave", path: "/usr/bin/brave-browser" },
    { kind: "brave", path: "/usr/bin/brave-browser-stable" },
    { kind: "brave", path: "/usr/bin/brave" },
    { kind: "brave", path: "/snap/bin/brave" },
    { kind: "edge", path: "/usr/bin/microsoft-edge" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-stable" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  // Must use bracket notation: variable name contains parentheses
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const joinWin = path.win32.join;
  const candidates: Array<BrowserExecutable> = [];

  if (localAppData) {
    // Chrome (user install)
    candidates.push({
      kind: "chrome",
      path: joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    });
    // Brave (user install)
    candidates.push({
      kind: "brave",
      path: joinWin(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    });
    // Edge (user install)
    candidates.push({
      kind: "edge",
      path: joinWin(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    });
    // Chromium (user install)
    candidates.push({
      kind: "chromium",
      path: joinWin(localAppData, "Chromium", "Application", "chrome.exe"),
    });
    // Chrome Canary (user install)
    candidates.push({
      kind: "canary",
      path: joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
    });
  }

  // Chrome (system install, 64-bit)
  candidates.push({
    kind: "chrome",
    path: joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
  });
  // Chrome (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "chrome",
    path: joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  });
  // Brave (system install, 64-bit)
  candidates.push({
    kind: "brave",
    path: joinWin(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  });
  // Brave (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "brave",
    path: joinWin(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  });
  // Edge (system install, 64-bit)
  candidates.push({
    kind: "edge",
    path: joinWin(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  });
  // Edge (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "edge",
    path: joinWin(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  });

  return findFirstExecutable(candidates);
}

export function resolveBrowserExecutableForPlatform(
  resolved: ResolvedBrowserConfig,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (resolved.executablePath) {
    if (!exists(resolved.executablePath)) {
      throw new Error(`browser.executablePath not found: ${resolved.executablePath}`);
    }
    return { kind: "custom", path: resolved.executablePath };
  }

  if (platform === "darwin") return findChromeExecutableMac();
  if (platform === "linux") return findChromeExecutableLinux();
  if (platform === "win32") return findChromeExecutableWindows();
  return null;
}
