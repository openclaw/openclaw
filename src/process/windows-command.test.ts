// Windows command tests cover command quoting and shell resolution on Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWindowsCommandShim } from "./windows-command.js";

describe("resolveWindowsCommandShim", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-command-test-"));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

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

  it("walks PATH and returns the first .cmd hit on Windows", () => {
    if (!tempDir) {
      throw new Error("tempDir not initialized");
    }
    const claudePath = path.join(tempDir, "claude.cmd");
    fs.writeFileSync(claudePath, "@echo off\r\n");
    expect(
      resolveWindowsCommandShim({
        command: "claude",
        cmdCommands: ["npm", "pnpm", "yarn", "npx"],
        platform: "win32",
        env: { PATH: tempDir },
      }),
    ).toBe(claudePath);
  });

  it("prefers .cmd over .bat when both exist", () => {
    if (!tempDir) {
      throw new Error("tempDir not initialized");
    }
    const batPath = path.join(tempDir, "tool.bat");
    const cmdPath = path.join(tempDir, "tool.cmd");
    fs.writeFileSync(batPath, "@echo off\r\n");
    fs.writeFileSync(cmdPath, "@echo off\r\n");
    expect(
      resolveWindowsCommandShim({
        command: "tool",
        cmdCommands: [],
        platform: "win32",
        env: { PATH: tempDir },
      }),
    ).toBe(cmdPath);
  });

  it("returns the original command when nothing matches on PATH", () => {
    if (!tempDir) {
      throw new Error("tempDir not initialized");
    }
    expect(
      resolveWindowsCommandShim({
        command: "definitely-not-on-path",
        cmdCommands: ["npm", "pnpm", "yarn", "npx"],
        platform: "win32",
        env: { PATH: tempDir },
      }),
    ).toBe("definitely-not-on-path");
  });

  it("returns the original command when PATH is empty", () => {
    expect(
      resolveWindowsCommandShim({
        command: "claude",
        cmdCommands: ["npm", "pnpm", "yarn", "npx"],
        platform: "win32",
        env: { PATH: "" },
      }),
    ).toBe("claude");
  });

  it("skips absolute commands (no PATH walk)", () => {
    // resolveWindowsCommandShim is only called with bare names by the
    // supervisor today, but guard against future callers passing absolutes.
    expect(
      resolveWindowsCommandShim({
        command: "C:\\Windows\\System32\\cmd.exe",
        cmdCommands: [],
        platform: "win32",
        env: { PATH: "" },
      }),
    ).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});
