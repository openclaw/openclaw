import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("node:os", () => {
  const homedir = vi.fn();
  return {
    homedir,
    default: { homedir },
  };
});
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";

async function loadResolveBrowserExecutableForPlatform() {
  const mod = await import("./chrome.executables.js");
  return mod.resolveBrowserExecutableForPlatform;
}

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
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/Users/test");
  });

  it("prefers default Chromium browser on macOS", async () => {
    mockMacDefaultBrowser("com.google.Chrome", "/Applications/Google Chrome.app");
    mockChromeExecutableExists();
    const resolveBrowserExecutableForPlatform = await loadResolveBrowserExecutableForPlatform();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(exe?.kind).toBe("chrome");
  });

  it("falls back when default browser is non-Chromium on macOS", async () => {
    mockMacDefaultBrowser("com.apple.Safari");
    mockChromeExecutableExists();
    const resolveBrowserExecutableForPlatform = await loadResolveBrowserExecutableForPlatform();

    const exe = resolveBrowserExecutableForPlatform(
      {} as Parameters<typeof resolveBrowserExecutableForPlatform>[0],
      "darwin",
    );

    expect(exe?.path).toContain("Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
