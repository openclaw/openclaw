import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWindowsSpawnProgramCandidate } from "./windows-spawn.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-winspawn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("resolveWindowsSpawnProgramCandidate", () => {
  it("resolves scoped package bin from unscoped wrapper basename", async () => {
    const root = await createTempDir();
    const binDir = path.join(root, "bin");
    const packageDir = path.join(root, "node_modules", "@scope", "acpx");
    const distDir = path.join(packageDir, "dist");
    const wrapperPath = path.join(binDir, "acpx.cmd");
    const entryPath = path.join(distDir, "cli.js");

    await fs.mkdir(distDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(entryPath, "#!/usr/bin/env node\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@scope/acpx", bin: { acpx: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const candidate = resolveWindowsSpawnProgramCandidate({
      command: wrapperPath,
      platform: "win32",
      env: {},
      execPath: "C:\\node\\node.exe",
      packageName: "@scope/acpx",
    });

    expect(candidate.command).toBe("C:\\node\\node.exe");
    expect(candidate.leadingArgv).toHaveLength(1);
    expect(await fs.realpath(candidate.leadingArgv[0])).toBe(await fs.realpath(entryPath));
    expect(candidate.resolution).toBe("node-entrypoint");
    expect(candidate.windowsHide).toBe(true);
  });
});
