import { describe, expect, it } from "vitest";
import { buildNodeShellCommand } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  it("uses cmd.exe for win-prefixed platform labels", () => {
    expect(buildNodeShellCommand("echo hi", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", "windows")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", " Windows 11 ")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("uses current shell for non-windows and missing platform values", () => {
    const shell = process.env.SHELL || "/bin/sh";
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual([shell, "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "linux")).toEqual([shell, "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi")).toEqual([shell, "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", null)).toEqual([shell, "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "   ")).toEqual([shell, "-lc", "echo hi"]);
  });
});
