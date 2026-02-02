import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { withTempHome } from "./test-helpers.js";

describe("config backup rotation", () => {
  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const { resolveConfigBackupBasePath, resolveConfigPath, writeConfigFile } =
        await import("./config.js");
      const configPath = resolveConfigPath();
      const backupBase = resolveConfigBackupBasePath(configPath);
      const buildConfig = (version: number): OpenClawConfig =>
        ({
          agents: { list: [{ id: `v${version}` }] },
        }) as OpenClawConfig;

      for (let version = 0; version <= 6; version += 1) {
        await writeConfigFile(buildConfig(version));
      }

      const readName = async (filePath: string) => {
        const raw = await fs.readFile(filePath, "utf-8");
        return (
          (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
            ?.id ?? null
        );
      };

      await expect(readName(configPath)).resolves.toBe("v6");
      await expect(readName(backupBase)).resolves.toBe("v5");
      await expect(readName(`${backupBase}.1`)).resolves.toBe("v4");
      await expect(readName(`${backupBase}.2`)).resolves.toBe("v3");
      await expect(readName(`${backupBase}.3`)).resolves.toBe("v2");
      await expect(readName(`${backupBase}.4`)).resolves.toBe("v1");
      await expect(fs.stat(`${backupBase}.5`)).rejects.toThrow();
    });
  });

  it("moves legacy backups into the backups folder", async () => {
    await withTempHome(async () => {
      const { migrateLegacyConfigBackups, resolveConfigBackupDir, resolveConfigPath } =
        await import("./config.js");
      const configPath = resolveConfigPath();
      const configDir = path.dirname(configPath);
      const backupDir = resolveConfigBackupDir(configPath);

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(`${configPath}.bak`, "legacy");
      await fs.writeFile(`${configPath}.bak.1`, "legacy-1");

      const result = await migrateLegacyConfigBackups();
      await expect(
        fs.stat(path.join(backupDir, `${path.basename(configPath)}.bak`)),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(backupDir, `${path.basename(configPath)}.bak.1`)),
      ).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak`)).rejects.toThrow();
      expect(result.moved.length).toBe(2);
    });
  });
});
