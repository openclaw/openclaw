import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_BACKUP_DIR_NAME,
  resolveConfigBackupPath,
  rotateConfigBackups,
} from "./backup-rotation.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  it("keeps backups in config-backup/ with datetime naming", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
      if (!stateDir) {
        throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
      }
      const configPath = path.join(stateDir, "openclaw.json");
      const backupDir = path.join(stateDir, CONFIG_BACKUP_DIR_NAME);
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
        const backupPath = resolveConfigBackupPath(configPath);
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(configPath, backupPath).catch(() => {
          // best-effort
        });
        await writeVersion(version);
        // Small delay to ensure unique timestamps
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // Current config should be latest
      const currentRaw = await fs.readFile(configPath, "utf-8");
      expect(
        (JSON.parse(currentRaw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
          ?.id,
      ).toBe("v6");

      // Backup directory should exist with datetime-named files
      const entries = await fs.readdir(backupDir);
      const backups = entries.filter((e) => e.startsWith("openclaw.json.bak.")).toSorted();

      // Should have at most CONFIG_BACKUP_COUNT (5) backups
      expect(backups.length).toBeLessThanOrEqual(5);
      expect(backups.length).toBeGreaterThan(0);

      // Each backup should match the datetime pattern
      for (const backup of backups) {
        expect(backup).toMatch(
          /^openclaw\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
        );
      }
    });
  });
});
