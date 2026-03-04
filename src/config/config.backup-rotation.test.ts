import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
  getBackupCount,
  getBackupPath,
  buildBackupPath,
  type BackupConfig,
} from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
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

  // chmod is a no-op on Windows — 0o600 can never be observed there.
  it.skipIf(IS_WINDOWS)("hardenBackupPermissions sets 0o600 on all backup files", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create .bak and .bak.1 with permissive mode
      await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.1`, "secret", { mode: 0o644 });

      await hardenBackupPermissions(configPath, fs);

      const bakStat = await fs.stat(`${configPath}.bak`);
      const bak1Stat = await fs.stat(`${configPath}.bak.1`);

      expectPosixMode(bakStat.mode, 0o600);
      expectPosixMode(bak1Stat.mode, 0o600);
    });
  });

  it("cleanOrphanBackups removes stale files outside the rotation ring", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create valid backups
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "backup-0");
      await fs.writeFile(`${configPath}.bak.1`, "backup-1");
      await fs.writeFile(`${configPath}.bak.2`, "backup-2");

      // Create orphans
      await fs.writeFile(`${configPath}.bak.1772352289`, "orphan-pid");
      await fs.writeFile(`${configPath}.bak.before-marketing`, "orphan-manual");
      await fs.writeFile(`${configPath}.bak.99`, "orphan-overflow");

      await cleanOrphanBackups(configPath, fs);

      // Valid backups preserved
      await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.1`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.2`)).resolves.toBeDefined();

      // Orphans removed
      await expect(fs.stat(`${configPath}.bak.1772352289`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.before-marketing`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.99`)).rejects.toThrow();

      // Main config untouched
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("current");
    });
  });

  it("maintainConfigBackups composes rotate/copy/harden/prune flow", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.orphan`, "old");

      await maintainConfigBackups(configPath, fs);

      // A new primary backup is created from the current config.
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets rotated into ring slot 1.
      await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
      // Windows cannot validate POSIX chmod bits, but all other compose assertions
      // should still run there.
      if (!IS_WINDOWS) {
        const primaryBackupStat = await fs.stat(`${configPath}.bak`);
        expectPosixMode(primaryBackupStat.mode, 0o600);
      }
      // Out-of-ring orphan gets pruned.
      await expect(fs.stat(`${configPath}.bak.orphan`)).rejects.toThrow();
    });
  });

  describe("configurable backup options", () => {
    it("getBackupCount returns default when not configured", () => {
      expect(getBackupCount(undefined)).toBe(5);
      expect(getBackupCount({})).toBe(5);
      expect(getBackupCount({ maxFiles: undefined })).toBe(5);
    });

    it("getBackupCount returns configured value", () => {
      expect(getBackupCount({ maxFiles: 10 })).toBe(10);
      expect(getBackupCount({ maxFiles: 1 })).toBe(1);
      expect(getBackupCount({ maxFiles: 50 })).toBe(50);
    });

    it("getBackupPath returns config directory when not configured", () => {
      const configPath = "/home/user/.openclaw/openclaw.json";
      expect(getBackupPath(configPath, undefined)).toBe("/home/user/.openclaw");
      expect(getBackupPath(configPath, {})).toBe("/home/user/.openclaw");
      expect(getBackupPath(configPath, { path: undefined })).toBe("/home/user/.openclaw");
    });

    it("getBackupPath returns custom path with tilde expansion", () => {
      const configPath = "/home/user/.openclaw/openclaw.json";
      expect(getBackupPath(configPath, { path: "~/backups" })).toBe(
        path.join(process.env.HOME || "", "backups"),
      );
      expect(getBackupPath(configPath, { path: "/custom/backup/path" })).toBe(
        "/custom/backup/path",
      );
    });

    it("buildBackupPath creates correct paths", () => {
      const configPath = "/home/user/.openclaw/openclaw.json";
      expect(buildBackupPath("/home/user/.openclaw", configPath)).toBe(
        "/home/user/.openclaw/openclaw.json.bak",
      );
      expect(buildBackupPath("/home/user/.openclaw", configPath, ".1")).toBe(
        "/home/user/.openclaw/openclaw.json.bak.1",
      );
      expect(buildBackupPath("/custom/backup", configPath)).toBe(
        "/custom/backup/openclaw.json.bak",
      );
    });

    it("rotateConfigBackups respects maxFiles config", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const customConfig: BackupConfig = { maxFiles: 3 };

        // Write initial config
        await fs.writeFile(configPath, JSON.stringify({ v: 1 }), "utf-8");
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});

        // Rotate with custom maxFiles
        await rotateConfigBackups(configPath, fs, customConfig);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});
        await fs.writeFile(configPath, JSON.stringify({ v: 2 }), "utf-8");

        await rotateConfigBackups(configPath, fs, customConfig);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});
        await fs.writeFile(configPath, JSON.stringify({ v: 3 }), "utf-8");

        await rotateConfigBackups(configPath, fs, customConfig);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});
        await fs.writeFile(configPath, JSON.stringify({ v: 4 }), "utf-8");

        // With maxFiles=3, we should have .bak, .bak.1, .bak.2 but NOT .bak.3
        await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
        await expect(fs.stat(`${configPath}.bak.1`)).resolves.toBeDefined();
        await expect(fs.stat(`${configPath}.bak.2`)).resolves.toBeDefined();
        await expect(fs.stat(`${configPath}.bak.3`)).rejects.toThrow();
      });
    });

    it("maintainConfigBackups uses custom path", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const backupDir = path.join(path.dirname(configPath), "custom-backups");

        // Create custom backup directory
        await fs.mkdir(backupDir, { recursive: true }).catch(() => {});

        const customConfig: BackupConfig = { path: backupDir, maxFiles: 3 };

        await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });

        await maintainConfigBackups(configPath, fs, customConfig);

        // Backup should be in custom directory
        const customBackupPath = path.join(backupDir, path.basename(configPath) + ".bak");
        await expect(fs.readFile(customBackupPath, "utf-8")).resolves.toBe(
          JSON.stringify({ token: "secret" }),
        );

        // Original directory should not have backups
        await expect(fs.stat(`${configPath}.bak`)).rejects.toThrow();

        // Clean up custom backup dir
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      });
    });
  });
});
