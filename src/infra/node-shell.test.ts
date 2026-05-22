// Covers platform shell argv construction.
import type fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildNodeShellCommand,
  type NodeExecCwdFilesystem,
  resolveNodeExecCwd,
  resolveNodeShellCommand,
} from "./node-shell.js";

function fakeCwdFilesystem(existingDirs: string[]): NodeExecCwdFilesystem {
  return {
    statSync: ((target: fs.PathLike) => {
      if (existingDirs.includes(String(target))) {
        return { isDirectory: () => true } as fs.Stats;
      }
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as typeof fs.statSync,
  };
}

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

  it("uses /bin/sh for non-windows and missing platform values", () => {
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "linux")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", null)).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "   ")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });

  it("resolves /usr/bin/sh before approval when /bin/sh is missing", () => {
    expect(
      resolveNodeShellCommand(["/bin/sh", "-lc", "echo hi"], {
        existsSync: (candidate) => candidate === "/usr/bin/sh",
      }),
    ).toEqual({
      argv: ["/usr/bin/sh", "-lc", "echo hi"],
      changed: true,
    });
  });

  it("keeps the planned shell when /bin/sh exists or argv is not the node shell wrapper", () => {
    expect(
      resolveNodeShellCommand(["/bin/sh", "-lc", "echo hi"], {
        existsSync: (candidate) => candidate === "/bin/sh",
      }),
    ).toEqual({
      argv: ["/bin/sh", "-lc", "echo hi"],
      changed: false,
    });
    expect(
      resolveNodeShellCommand(["cmd.exe", "/c", "echo hi"], {
        existsSync: () => false,
      }),
    ).toEqual({
      argv: ["cmd.exe", "/c", "echo hi"],
      changed: false,
    });
  });
});

describe("resolveNodeExecCwd", () => {
  it("drops a cwd that does not exist on the node host", () => {
    expect(resolveNodeExecCwd("/gateway/container/path", fakeCwdFilesystem([]))).toEqual({
      cwd: undefined,
      changed: true,
    });
  });

  it("drops a cwd that exists but is not a directory", () => {
    expect(
      resolveNodeExecCwd("/etc/hostname", {
        statSync: (() => ({ isDirectory: () => false }) as fs.Stats) as typeof fs.statSync,
      }),
    ).toEqual({
      cwd: undefined,
      changed: true,
    });
  });

  it("keeps a cwd that resolves to a directory on the node host", () => {
    expect(resolveNodeExecCwd("/home/node/work", fakeCwdFilesystem(["/home/node/work"]))).toEqual({
      cwd: "/home/node/work",
      changed: false,
    });
  });

  it("leaves an unset cwd untouched", () => {
    expect(resolveNodeExecCwd(undefined, fakeCwdFilesystem([]))).toEqual({
      cwd: undefined,
      changed: false,
    });
    expect(resolveNodeExecCwd("", fakeCwdFilesystem([]))).toEqual({
      cwd: "",
      changed: false,
    });
  });
});
