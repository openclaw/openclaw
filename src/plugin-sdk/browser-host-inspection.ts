import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserExecutable = {
  kind: "chrome" | "chromium" | "edge" | "canary";
  path: string;
};

const CHROME_VERSION_RE = /\b(\d+)(?:\.\d+){1,3}\b/g;

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function execText(
  command: string,
  args: string[],
  timeoutMs = 1200,
  maxBuffer = 1024 * 1024,
): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer,
    });
    return String(output ?? "").trim() || null;
  } catch {
    return null;
  }
}

function findFirstChromeExecutable(candidates: string[]): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      const normalizedPath = candidate.toLowerCase();
      return {
        kind:
          normalizedPath.includes("beta") ||
          normalizedPath.includes("canary") ||
          normalizedPath.includes("sxs") ||
          normalizedPath.includes("unstable")
            ? "canary"
            : "chrome",
        path: candidate,
      };
    }
  }
  return null;
}

function findGoogleChromeExecutableMac(): BrowserExecutable | null {
  return findFirstChromeExecutable([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(
      os.homedir(),
      "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ),
  ]);
}

function findGoogleChromeExecutableLinux(): BrowserExecutable | null {
  return findFirstChromeExecutable([
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome-beta",
    "/usr/bin/google-chrome-unstable",
    "/snap/bin/google-chrome",
  ]);
}

function findGoogleChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const joinWin = path.win32.join;
  const candidates: string[] = [];

  if (localAppData) {
    candidates.push(joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
    candidates.push(joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"));
  }

  candidates.push(joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
  candidates.push(joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));

  return findFirstChromeExecutable(candidates);
}

export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (platform === "darwin") {
    return findGoogleChromeExecutableMac();
  }
  if (platform === "linux") {
    return findGoogleChromeExecutableLinux();
  }
  if (platform === "win32") {
    return findGoogleChromeExecutableWindows();
  }
  return null;
}

export function readBrowserVersion(executablePath: string): string | null {
  const output = execText(executablePath, ["--version"], 2000);
  if (!output) {
    return null;
  }
  return output.replace(/\s+/g, " ").trim();
}

export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  const matches = [...String(rawVersion ?? "").matchAll(CHROME_VERSION_RE)];
  const match = matches.at(-1);
  if (!match?.[1]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}
