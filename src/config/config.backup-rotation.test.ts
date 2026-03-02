import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupConfigBackups, rotateConfigBackups } from "./backup-rotation.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
      if (!stateDir) {
        throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
      }
      const configPath = path.join(stateDir, "openclaw.json");
      const buildConfig = (version: number): OpenClawConfig =>
        ({
          agents: { list: [{ id: `v${version}` }] },
        }) as OpenClawConfig;

      const writeVersion = async (version: number) => {
        const json = JSON.stringify(buildConfig(version), null, 2).trimEnd().concat("\n");
        await fs.writeFile(configPath, json, "utf-8");
      };

      await writeVersion(0);
      for (let version = 1; version <= 6; version += 1) {
        await rotateConfigBackups(configPath, fs);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {
          // best-effort
        });
        await writeVersion(version);
      }

      const readName = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (
          (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
            ?.id ?? null
        );
      };

      await expect(readName()).resolves.toBe("v6");
      await expect(readName(".bak")).resolves.toBe("v5");
      await expect(readName(".bak.1")).resolves.toBe("v4");
      await expect(readName(".bak.2")).resolves.toBe("v3");
      await expect(readName(".bak.3")).resolves.toBe("v2");
      await expect(readName(".bak.4")).resolves.toBe("v1");
      await expect(fs.stat(`${configPath}.bak.5`)).rejects.toThrow();
    });
  });

  it("cleanupConfigBackups removes all backup files", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
      if (!stateDir) {
        throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
      }
      const configPath = path.join(stateDir, "openclaw.json");

      // Create main config and several backup files
      await fs.writeFile(configPath, '{"version": "main"}', "utf-8");
      await fs.writeFile(`${configPath}.bak`, '{"version": "bak"}', "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, '{"version": "bak.1"}', "utf-8");
      await fs.writeFile(`${configPath}.bak.2`, '{"version": "bak.2"}', "utf-8");
      await fs.writeFile(`${configPath}.bak.3`, '{"version": "bak.3"}', "utf-8");
      await fs.writeFile(`${configPath}.bak.4`, '{"version": "bak.4"}', "utf-8");

      // Verify backups exist before cleanup
      await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.1`)).resolves.toBeDefined();

      // Run cleanup
      await cleanupConfigBackups(configPath, fs);

      // Verify main config still exists
      await expect(fs.stat(configPath)).resolves.toBeDefined();

      // Verify all backup files are removed
      await expect(fs.stat(`${configPath}.bak`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.1`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.2`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.3`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.4`)).rejects.toThrow();
    });
  });

  it("cleanupConfigBackups handles missing backup files gracefully", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
      if (!stateDir) {
        throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
      }
      const configPath = path.join(stateDir, "openclaw.json");

      // Create main config but no backups
      await fs.writeFile(configPath, '{"version": "main"}', "utf-8");

      // Should not throw even when no backup files exist
      await expect(cleanupConfigBackups(configPath, fs)).resolves.not.toThrow();

      // Main config should still exist
      await expect(fs.stat(configPath)).resolves.toBeDefined();
    });
  });
});
