// Covers platform shell argv construction.
import { describe, expect, it } from "vitest";
import { buildNodeCommandInvocation, buildNodeShellCommand } from "./node-shell.js";

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

  it("uses bindable non-login sh for macOS nodes", () => {
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS 26.5.2")).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("retains login sh for other posix and missing platform values", () => {
    expect(buildNodeShellCommand("echo hi", "linux")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", null)).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "   ")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });
});

describe("buildNodeCommandInvocation", () => {
  it.each(["win32", "windows", " Windows 11 "])(
    "sends an eligible command to a %j node as a direct argv",
    (platform) => {
      expect(
        buildNodeCommandInvocation(
          '"C:\\Program Files\\Tool\\tool.exe"  "deux mots é" x',
          platform,
        ),
      ).toEqual({
        argv: ["C:\\Program Files\\Tool\\tool.exe", "deux mots é", "x"],
        rawCommand: '"C:\\Program Files\\Tool\\tool.exe" "deux mots é" x',
      });
    },
  );

  it.each(["echo hi", "tool a & tool b", 'tool "50%"', "build.cmd", 'tool "open'])(
    "keeps %j on the unchanged cmd.exe envelope",
    (command) => {
      expect(buildNodeCommandInvocation(command, "win32")).toEqual({
        argv: ["cmd.exe", "/d", "/s", "/c", command],
        rawCommand: command,
      });
    },
  );

  it.each([
    ["linux", ["/bin/sh", "-lc", "/usr/bin/printf ok"]],
    ["darwin", ["/bin/sh", "-c", "/usr/bin/printf ok"]],
    [null, ["/bin/sh", "-lc", "/usr/bin/printf ok"]],
  ])("keeps the %j shell transport unchanged", (platform, argv) => {
    expect(buildNodeCommandInvocation("/usr/bin/printf ok", platform)).toEqual({
      argv,
      rawCommand: "/usr/bin/printf ok",
    });
  });
});
