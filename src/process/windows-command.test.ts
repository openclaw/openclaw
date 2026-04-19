import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsCmdShimArgv, resolveWindowsCommandShim } from "./windows-command.js";

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

describe("resolveWindowsCmdShimArgv", () => {
  it("leaves argv unchanged outside Windows", () => {
    const argv = ["claude.cmd", "--print", "hi"];
    expect(resolveWindowsCmdShimArgv(argv, { platform: "linux" })).toEqual(argv);
  });

  it("leaves argv unchanged when argv[0] is not a .cmd", () => {
    const argv = ["node", "index.js"];
    expect(resolveWindowsCmdShimArgv(argv, { platform: "win32" })).toEqual(argv);
  });

  it("leaves argv unchanged when the shim path does not exist", () => {
    const argv = [path.join(os.tmpdir(), "does-not-exist-shim.cmd"), "--flag"];
    expect(resolveWindowsCmdShimArgv(argv, { platform: "win32" })).toEqual(argv);
  });

  it("resolves a .cmd shim to its underlying .exe target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shim-"));
    const exePath = path.join(dir, "target.exe");
    const shimPath = path.join(dir, "wrapper.cmd");
    fs.writeFileSync(exePath, "");
    fs.writeFileSync(shimPath, `@echo off\r\nSET dp0=%~dp0\r\n"%dp0%target.exe" %*\r\n`);
    try {
      expect(
        resolveWindowsCmdShimArgv([shimPath, "--flag", "value"], { platform: "win32" }),
      ).toEqual([exePath, "--flag", "value"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a .cmd shim to node.exe + <cli.js> when the target is a .js file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shim-"));
    const jsPath = path.join(dir, "cli.js");
    const shimPath = path.join(dir, "wrapper.cmd");
    fs.writeFileSync(jsPath, "");
    fs.writeFileSync(shimPath, `@echo off\r\nSET dp0=%~dp0\r\n"%dp0%cli.js" %*\r\n`);
    try {
      expect(
        resolveWindowsCmdShimArgv([shimPath, "--flag"], { platform: "win32" }),
      ).toEqual([process.execPath, jsPath, "--flag"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looks up a bare .cmd name on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shim-"));
    const exePath = path.join(dir, "target.exe");
    const shimPath = path.join(dir, "wrapper.cmd");
    fs.writeFileSync(exePath, "");
    fs.writeFileSync(shimPath, `@echo off\r\nSET dp0=%~dp0\r\n"%dp0%target.exe" %*\r\n`);
    try {
      expect(
        resolveWindowsCmdShimArgv(["wrapper.cmd", "--flag"], {
          platform: "win32",
          pathEnv: dir,
        }),
      ).toEqual([exePath, "--flag"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
