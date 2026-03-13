import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

const isWindows = process.platform === "win32";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-io-perm-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe("writeConfigFile permissions", () => {
  it.skipIf(isWindows)("writes config file with 0o600 permissions", async () => {
    await withTempDir(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fsp.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        configPath,
      });

      await io.writeConfigFile({});

      const stat = await fsp.stat(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  it("logs warning when chmod fails in copyFile fallback", async () => {
    await withTempDir(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fsp.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");

      const warnSpy = vi.fn();
      const errorSpy = vi.fn();

      // Create a custom fs that simulates the Windows rename-fail path
      const mockFs = {
        ...fs,
        existsSync: fs.existsSync,
        readFileSync: fs.readFileSync,
        promises: {
          ...fs.promises,
          // Simulate EPERM on rename to trigger the copyFile fallback path
          rename: vi.fn().mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" })),
          // Simulate chmod failure in the fallback path
          chmod: vi.fn().mockRejectedValue(new Error("Operation not permitted")),
        },
      };

      const io = createConfigIO({
        fs: mockFs as unknown as typeof fs,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        configPath,
        logger: { warn: warnSpy, error: errorSpy },
      });

      await io.writeConfigFile({});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set config file permissions to 0600"),
      );
    });
  });
});
