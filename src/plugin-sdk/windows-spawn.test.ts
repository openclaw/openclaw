import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "./windows-spawn.js";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return tempRoot;
}

describe("windows-spawn", () => {
  it("treats missing bare cmd shims as direct commands", () => {
    const candidate = resolveWindowsSpawnProgramCandidate({
      command: "qmd.cmd",
      platform: "win32",
      env: { PATH: "" },
      execPath: "C:\\node.exe",
      packageName: "qmd",
    });

    expect(candidate).toEqual({
      command: "qmd.cmd",
      leadingArgv: [],
      resolution: "direct",
    });
  });

  it("keeps relative cmd wrapper paths unresolved when they are not stat-able yet", () => {
    const candidate = resolveWindowsSpawnProgramCandidate({
      command: "scripts\\server.cmd",
      platform: "win32",
      env: { PATH: "" },
      execPath: "C:\\node.exe",
      packageName: "openclaw",
    });

    expect(candidate).toEqual({
      command: "scripts\\server.cmd",
      leadingArgv: [],
      resolution: "unresolved-wrapper",
    });
  });

  it("still fails closed for existing cmd shims without an inferred entrypoint", async () => {
    const shimDir = await makeTempDir("openclaw-windows-spawn-");
    const wrapperPath = path.join(shimDir, "qmd.cmd");
    await fs.writeFile(wrapperPath, "@echo off\r\n", "utf8");

    expect(() =>
      resolveWindowsSpawnProgram({
        command: "qmd.cmd",
        platform: "win32",
        env: { PATH: shimDir },
        execPath: "C:\\node.exe",
        packageName: "qmd",
        allowShellFallback: false,
      }),
    ).toThrow(/without shell execution/);
  });
});
