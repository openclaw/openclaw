import { describe, expect, it, vi } from "vitest";
import {
  assertSafeWindowsShellArgs,
  resolveRunner,
  shouldUseShellForCommand,
} from "../../scripts/ui.js";

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
});

describe("scripts/ui runner resolution", () => {
  it("prefers pnpm when it is on PATH", () => {
    expect(
      resolveRunner({
        which: (cmd) => (cmd === "pnpm" ? "/usr/local/bin/pnpm" : null),
        spawnSync: vi.fn(),
      }),
    ).toEqual({ cmd: "/usr/local/bin/pnpm", args: [], kind: "pnpm" });
  });

  it("falls back to corepack pnpm when pnpm is missing", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });

    expect(
      resolveRunner({
        which: (cmd) => (cmd === "corepack" ? "/usr/local/bin/corepack" : null),
        spawnSync,
      }),
    ).toEqual({
      cmd: "/usr/local/bin/corepack",
      args: ["pnpm"],
      kind: "corepack-pnpm",
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
