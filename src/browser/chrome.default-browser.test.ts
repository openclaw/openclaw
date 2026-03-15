import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveBrowserExecutableForPlatform } from "./chrome.executables.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("node:fs", () => {
  const existsSync = vi.fn();
  const readFileSync = vi.fn();
  return {
    existsSync,
    readFileSync,
    default: { existsSync, readFileSync },
  };
});
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

describe("browser default executable detection", () => {
  const launchServicesPlist = "com.apple.launchservices.secure.plist";
  const chromeExecutablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  function mockMacDefaultBrowser(bundleId: string, appPath = ""): void {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsStr = Array.isArray(args) ? args.join(" ") : "";
      if (cmd === "/usr/bin/plutil" && argsStr.includes("LSHandlers")) {
        return JSON.stringify([{ LSHandlerURLScheme: "http", LSHandlerRoleAll: bundleId }]);
      }
      if (cmd === "/usr/bin/osascript" && argsStr.includes("path to application id")) {
        return appPath;
      }
      if (cmd === "/usr/bin/defaults") {
        return "Google Chrome";
      }
      return "";
    });
  }

  function mockChromeExecutableExists(): void {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const value = String(p);
      if (value.includes(launchServicesPlist)) {
        return true;
      }
      return value.includes(chromeExecutablePath);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers default Chromium browser on macOS", () => {
    mockMacDefaultBrowser("com.google.Chrome", "/Applications/Google Chrome.app");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(exe?.kind).toBe("chrome");
  });

  it("falls back when default browser is non-Chromium on macOS", () => {
    mockMacDefaultBrowser("com.apple.Safari");
    mockChromeExecutableExists();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
