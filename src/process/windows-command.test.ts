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
        cmdCommands: ["pnpm", "yarn", "codex"],
        platform: "win32",
      }),
    ).toBe("pnpm.cmd");
  });

  it("resolves a codex.exe PATH match on Windows", () => {
    expect(
      resolveWindowsCommandShim({
        command: "codex",
        cmdCommands: ["codex"],
        platform: "win32",
        pathEnv: 'C:\\Tools;C:\\Other',
        pathExt: ".EXE;.CMD",
        fileExists: (candidate) => candidate === "C:\\Tools\\codex.exe",
      }),
    ).toBe("C:\\Tools\\codex.exe");
  });

  it("resolves a codex.cmd PATH match on Windows when no exe exists", () => {
    expect(
      resolveWindowsCommandShim({
        command: "codex",
        cmdCommands: ["codex"],
        platform: "win32",
        pathEnv: 'C:\\Tools;C:\\Other',
        pathExt: ".EXE;.CMD",
        fileExists: (candidate) => candidate === "C:\\Other\\codex.cmd",
      }),
    ).toBe("C:\\Other\\codex.cmd");
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

  it("falls back to .cmd when no PATH match is found", () => {
    expect(
      resolveWindowsCommandShim({
        command: "codex",
        cmdCommands: ["codex"],
        platform: "win32",
        pathEnv: 'C:\\Tools',
        pathExt: ".EXE;.CMD",
        fileExists: () => false,
      }),
    ).toBe("codex.cmd");
  });
});
