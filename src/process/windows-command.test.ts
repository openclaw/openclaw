// Windows command tests cover command quoting and shell resolution on Windows.
import { describe, expect, it } from "vitest";
import { resolveWindowsCommandShim } from "./windows-command.js";

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

  it("resolves unadorned commands via PATHEXT walker", () => {
    // PathExists stub: pretend only C:\tools\claude.cmd exists.
    const pathExists = (candidate: string) =>
      candidate === "C:\\tools\\claude.cmd";
    expect(
      resolveWindowsCommandShim({
        command: "claude",
        cmdCommands: [],
        platform: "win32",
        env: {
          PATHEXT: ".EXE;.BAT;.CMD",
          PATH: "C:\\tools;C:\\Windows\\System32",
        },
        pathExists,
      }),
    ).toBe("C:\\tools\\claude.cmd");
  });

  it("returns the input when PATHEXT walker finds no match", () => {
    const pathExists = () => false;
    expect(
      resolveWindowsCommandShim({
        command: "missing-tool",
        cmdCommands: [],
        platform: "win32",
        env: { PATHEXT: ".EXE;.CMD", PATH: "C:\\tools" },
        pathExists,
      }),
    ).toBe("missing-tool");
  });

  it("prefers .EXE over .CMD when both exist (PATHEXT order)", () => {
    const pathExists = (candidate: string) =>
      candidate === "C:\\tools\\node.exe";
    expect(
      resolveWindowsCommandShim({
        command: "node",
        cmdCommands: [],
        platform: "win32",
        env: { PATHEXT: ".EXE;.CMD", PATH: "C:\\tools" },
        pathExists,
      }),
    ).toBe("C:\\tools\\node.exe");
  });

  it("walks multiple PATH directories in order", () => {
    // Both files exist; the first one in PATH should win.
    const pathExists = () => true;
    expect(
      resolveWindowsCommandShim({
        command: "git",
        cmdCommands: [],
        platform: "win32",
        env: {
          PATHEXT: ".EXE;.CMD",
          PATH: "C:\\Program Files\\Git\\cmd;C:\\Windows",
        },
        pathExists,
      }),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });
});
