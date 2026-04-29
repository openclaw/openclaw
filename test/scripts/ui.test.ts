import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeWindowsShellArgs,
  prepareSpawnCommand,
  resolveRunner,
  shouldUseShellForCommand,
} from "../../scripts/ui.js";

const originalPath = process.env.Path;
const originalPATH = process.env.PATH;

describe("scripts/ui windows spawn behavior", () => {
  it("enables shell for Windows command launchers that require cmd.exe", () => {
    expect(
      shouldUseShellForCommand("C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.CMD", "win32"),
    ).toBe(true);
    expect(shouldUseShellForCommand("C:\\tools\\pnpm.bat", "win32")).toBe(true);
  });

  it("does not enable shell for non-shell launchers", () => {
    expect(shouldUseShellForCommand("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/local/bin/pnpm", "linux")).toBe(false);
  });

  it("quotes Windows shell launcher paths before passing them to spawn", () => {
    expect(prepareSpawnCommand("C:\\Program Files\\nodejs\\pnpm.cmd", "win32")).toBe(
      '"C:\\Program Files\\nodejs\\pnpm.cmd"',
    );
    expect(prepareSpawnCommand("C:\\Program Files\\nodejs\\pnpm.exe", "win32")).toBe(
      "C:\\Program Files\\nodejs\\pnpm.exe",
    );
    expect(prepareSpawnCommand("/usr/local/bin/pnpm", "linux")).toBe("/usr/local/bin/pnpm");
  });

  it("allows safe forwarded args when shell mode is required on Windows", () => {
    expect(() =>
      assertSafeWindowsShellArgs(["run", "build", "--filter", "@openclaw/ui"], "win32"),
    ).not.toThrow();
  });

  it("rejects dangerous forwarded args when shell mode is required on Windows", () => {
    expect(() => assertSafeWindowsShellArgs(["run", "build", "evil&calc"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
    expect(() => assertSafeWindowsShellArgs(["run", "build", "%PATH%"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
  });

  it("does not reject args on non-windows platforms", () => {
    expect(() => assertSafeWindowsShellArgs(["contains&metacharacters"], "linux")).not.toThrow();
  });

  it("falls back to corepack pnpm when pnpm is not on PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-runner-"));
    const corepackName = process.platform === "win32" ? "corepack.CMD" : "corepack";
    const corepackPath = path.join(tmp, corepackName);
    fs.writeFileSync(corepackPath, "", "utf8");
    process.env.Path = tmp;
    process.env.PATH = tmp;

    try {
      const runner = resolveRunner();
      expect(runner?.cmd).toBe(corepackPath);
      expect(runner?.argsPrefix).toEqual(["pnpm"]);
    } finally {
      process.env.Path = originalPath;
      process.env.PATH = originalPATH;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
