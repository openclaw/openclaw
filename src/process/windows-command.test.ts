// Windows command tests cover command quoting and shell resolution on Windows.
import { describe, expect, it } from "vitest";
import { buildWindowsBatchInvocation, resolveWindowsCommandShim } from "./windows-command.js";

describe("resolveWindowsCommandShim", () => {
  it("leaves commands unchanged outside Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["pnpm"],
        platform: "linux",
      }),
    ).toBe("pnpm");
  });

  it("appends .cmd for configured Windows shims", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("pnpm.cmd");
  });

  it("appends .cmd for corepack on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "corepack",
        cmdCommands: ["corepack", "pnpm", "yarn"],
        platform: "win32",
      }),
    ).toBe("corepack.cmd");
  });

  it("keeps explicit extensions on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "npm.cmd",
        cmdCommands: ["npm", "npx"],
        platform: "win32",
      }),
    ).toBe("npm.cmd");
  });

  it("appends .cmd for Claude CLI on Windows when configured by the caller", () => {
    expect(
      resolveWindowsCommandShim({
        command: "claude",
        cmdCommands: ["claude", "npm", "npx"],
        platform: "win32",
      }),
    ).toBe("claude.cmd");
  });
});

describe("buildWindowsBatchInvocation", () => {
  it("wraps Windows batch commands with a trusted cmd.exe invocation", () => {
    expect(
      buildWindowsBatchInvocation({
        command: "claude.cmd",
        args: ["--print", "hello world"],
        env: { SystemRoot: "C:\\TestWindows" },
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\TestWindows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", 'claude.cmd --print "hello world"'],
      windowsVerbatimArguments: true,
    });
  });

  it("does not wrap batch commands outside Windows", () => {
    expect(
      buildWindowsBatchInvocation({
        command: "claude.cmd",
        args: ["--print", "hello"],
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("rejects Windows cmd.exe metacharacters instead of enabling shell injection", () => {
    expect(() =>
      buildWindowsBatchInvocation({
        command: "claude.cmd",
        args: ["hello & calc.exe"],
        platform: "win32",
      }),
    ).toThrow(/Unsafe Windows cmd\.exe argument/);
  });
});
