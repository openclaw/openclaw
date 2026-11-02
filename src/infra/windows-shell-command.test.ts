import { describe, expect, it } from "vitest";
import { analyzeWindowsShellCommand, isWindowsPlatform } from "./windows-shell-command.js";

describe("isWindowsPlatform", () => {
  it("respects explicit platform overrides", () => {
    expect(isWindowsPlatform("win32")).toBe(true);
    expect(isWindowsPlatform("linux")).toBe(false);
    expect(isWindowsPlatform("darwin")).toBe(false);
    expect(isWindowsPlatform("freebsd")).toBe(false);
  });

  it.each(["win32", "linux"])("defaults to the %s host for absent overrides", (platform) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const expected = platform === "win32";
      expect(isWindowsPlatform()).toBe(expected);
      expect(isWindowsPlatform(undefined)).toBe(expected);
      expect(isWindowsPlatform(null)).toBe(expected);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

describe("analyzeWindowsShellCommand", () => {
  it("defaults to process.platform when platform is omitted", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = analyzeWindowsShellCommand({ command: "Get-Process" });
      expect(result.ok).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
