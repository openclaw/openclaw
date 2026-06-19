// Windows command tests cover command quoting and shell resolution on Windows.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsBatchSpawnArgv, resolveWindowsCommandShim } from "./windows-command.js";

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
});

// Helper: create a real .cmd shim in a temp dir and splice into PATH
function withTempShim(
  name: string,
  ext: string,
  cb: (env: NodeJS.ProcessEnv) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shim-"));
  const shimPath = path.join(dir, name + ext);
  fs.writeFileSync(shimPath, "@echo off\r\necho shim-ok\r\n");
  const env = { ...process.env, PATH: dir + ";" + (process.env["PATH"] ?? "") };
  try {
    cb(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveWindowsBatchSpawnArgv", () => {
  it("returns undefined on non-Windows platforms", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const argv = resolveWindowsBatchSpawnArgv("claude", ["--version"], process.env);
      expect(argv).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("returns undefined for unresolvable commands", () => {
    if (process.platform !== "win32") return;
    const argv = resolveWindowsBatchSpawnArgv(
      "this-command-does-not-exist-oc-test",
      [],
      { ...process.env, PATH: "" },
    );
    expect(argv).toBeUndefined();
  });

  it("resolves a .cmd shim to trusted cmd.exe wrapper argv", () => {
    if (process.platform !== "win32") return;
    withTempShim("fakeclaude", ".cmd", (env) => {
      const argv = resolveWindowsBatchSpawnArgv("fakeclaude", ["--version"], env);
      expect(argv).toBeDefined();
      expect(argv![0]).toMatch(/[Cc]md\.exe$/);
      expect(argv![1]).toBe("/d");
      expect(argv![2]).toBe("/s");
      expect(argv![3]).toBe("/c");
      expect(argv![4]).toContain("fakeclaude.cmd");
      expect(argv![4]).toContain("--version");
    });
  });

  it("returns undefined for .exe commands (no wrapping needed)", () => {
    if (process.platform !== "win32") return;
    // node.exe is always on PATH in test context
    const argv = resolveWindowsBatchSpawnArgv("node", ["--version"], process.env);
    expect(argv).toBeUndefined();
  });

  it("rejects unsafe metacharacters in argv tokens", () => {
    if (process.platform !== "win32") return;
    withTempShim("safecmd", ".cmd", (env) => {
      expect(() =>
        resolveWindowsBatchSpawnArgv("safecmd", ["--flag", "arg & evil"], env),
      ).toThrow(/unsafe character/);
    });
  });

  it("npm shim resolves via PATHEXT walk (backward compat)", () => {
    if (process.platform !== "win32") return;
    withTempShim("npm", ".cmd", (env) => {
      const argv = resolveWindowsBatchSpawnArgv("npm", ["install"], env);
      expect(argv).toBeDefined();
      expect(argv![4]).toContain("npm.cmd");
      expect(argv![4]).toContain("install");
    });
  });
});
