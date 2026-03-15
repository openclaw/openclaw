import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listConfigBackups,
  createConfigBackup,
  restoreConfigBackup,
  attemptConfigRollback,
  cleanupFailedBackups,
  getBackupStats,
  type BackupRestoreFs,
} from "./config-backup-restore.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

function resolveConfigPathFromTempState(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR not set");
  }
  return path.join(stateDir, "openclaw.json");
}

interface MockFs {
  files: Map<string, string>;
  stats: Map<string, { size: number; mtime: Date }>;
}

function createMockFs(): { fs: BackupRestoreFs; state: MockFs } {
  const state: MockFs = {
    files: new Map(),
    stats: new Map(),
  };

  const fs: BackupRestoreFs = {
    copyFile: async (from: string, to: string) => {
      const content = state.files.get(from);
      if (content === undefined) {
        throw new Error(`File not found: ${from}`);
      }
      state.files.set(to, content);
      state.stats.set(to, { size: content.length, mtime: new Date() });
    },
    readFile: async (path: string) => {
      const content = state.files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    writeFile: async (path: string, data: string) => {
      state.files.set(path, data);
      state.stats.set(path, { size: data.length, mtime: new Date() });
    },
    stat: async (path: string) => {
      const stat = state.stats.get(path);
      if (!stat) {
        throw new Error(`File not found: ${path}`);
      }
      return stat;
    },
    readdir: async (dir: string) => {
      const files: string[] = [];
      for (const filepath of state.files.keys()) {
        if (filepath.startsWith(dir)) {
          const rel = path.relative(dir, filepath);
          if (!rel.includes("/")) {
            files.push(rel);
          }
        }
      }
      return files;
    },
    unlink: async (path: string) => {
      state.files.delete(path);
      state.stats.delete(path);
    },
    rename: async (from: string, to: string) => {
      const content = state.files.get(from);
      if (content === undefined) {
        throw new Error(`File not found: ${from}`);
      }
      state.files.set(to, content);
      state.files.delete(from);
      const stat = state.stats.get(from);
      state.stats.set(to, stat || { size: content.length, mtime: new Date() });
      state.stats.delete(from);
    },
  };

  return { fs, state };
}

describe("config-backup-restore", () => {
  describe("listConfigBackups", () => {
    it("returns empty array when no backups exist", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, JSON.stringify({ token: "test" }), "utf-8");

        const backups = await listConfigBackups(configPath);
        expect(backups).toEqual([]);
      });
    });

    it("lists primary .bak file", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup" }), "utf-8");

        const backups = await listConfigBackups(configPath);

        expect(backups.length).toBe(1);
        expect(backups[0].path).toBe(`${configPath}.bak`);
        expect(backups[0].label).toBe("latest");
      });
    });

    it("lists numbered backups sorted by timestamp (newest first)", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup1" }), "utf-8");

        // Create numbered backups with slight delay to ensure different mtimes
        await new Promise((r) => setTimeout(r, 10));
        await fs.writeFile(`${configPath}.bak.1`, JSON.stringify({ token: "backup2" }), "utf-8");
        await new Promise((r) => setTimeout(r, 10));
        await fs.writeFile(`${configPath}.bak.2`, JSON.stringify({ token: "backup3" }), "utf-8");

        const backups = await listConfigBackups(configPath);

        expect(backups.length).toBe(3);
        // Should be sorted newest first - .bak.2 was created last, .bak.1 before it, .bak first
        expect(backups[0].path).toBe(`${configPath}.bak.2`); // newest
        expect(backups[1].path).toBe(`${configPath}.bak.1`);
        expect(backups[2].path).toBe(`${configPath}.bak`); // oldest
      });
    });

    it("works with mock filesystem", async () => {
      const { fs, state } = createMockFs();
      const configPath = "/test/config.json";

      // Setup mock files
      const config = JSON.stringify({ token: "test" });
      state.files.set(configPath, config);
      state.stats.set(configPath, { size: config.length, mtime: new Date() });

      const backup = JSON.stringify({ token: "backup" });
      state.files.set(`${configPath}.bak`, backup);
      state.stats.set(`${configPath}.bak`, { size: backup.length, mtime: new Date() });

      const backups = await listConfigBackups(configPath, fs);

      expect(backups.length).toBe(1);
      expect(backups[0].path).toBe(`${configPath}.bak`);
    });
  });

  describe("createConfigBackup", () => {
    it("creates timestamped backup by default", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const config: OpenClawConfig = { gateway: { port: 18789 } };
        await fs.writeFile(configPath, JSON.stringify(config), "utf-8");

        const backup = await createConfigBackup(configPath, { timestamp: true });

        expect(backup.path).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}/);
        expect(backup.size).toBeGreaterThan(0);

        // Verify backup content
        const backupContent = await fs.readFile(backup.path, "utf-8");
        expect(JSON.parse(backupContent)).toEqual(config);
      });
    });

    it("creates backup with label", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const config: OpenClawConfig = { gateway: { port: 18789 } };
        await fs.writeFile(configPath, JSON.stringify(config), "utf-8");

        const backup = await createConfigBackup(configPath, {
          timestamp: true,
          label: "before-upgrade",
        });

        expect(backup.path).toContain("before-upgrade");
        expect(backup.label).toBe("before-upgrade");
      });
    });

    it("creates primary .bak without timestamp option", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const config: OpenClawConfig = { gateway: { port: 18789 } };
        await fs.writeFile(configPath, JSON.stringify(config), "utf-8");

        const backup = await createConfigBackup(configPath, { timestamp: false });

        expect(backup.path).toBe(`${configPath}.bak`);
        expect(backup.label).toBe("latest");
      });
    });

    it("throws when config directory does not exist", async () => {
      await withTempHome(async () => {
        const configPath = "/nonexistent/path/config.json";

        await expect(createConfigBackup(configPath)).rejects.toThrow(
          "Config directory does not exist",
        );
      });
    });

    it("throws when config file cannot be read", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        // Don't create the config file

        await expect(createConfigBackup(configPath)).rejects.toThrow("Failed to read config");
      });
    });
  });

  describe("restoreConfigBackup", () => {
    it("restores from primary backup", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create current config and backup
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup" }), "utf-8");

        const result = await restoreConfigBackup(configPath);

        expect(result.success).toBe(true);
        expect(result.backupPath).toBe(`${configPath}.bak`);

        // Verify restored content
        const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(restored.token).toBe("backup");
      });
    });

    it("falls back to numbered backup if primary doesn't exist", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Only create numbered backup, no primary
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak.1`, JSON.stringify({ token: "backup1" }), "utf-8");

        const result = await restoreConfigBackup(configPath);

        expect(result.success).toBe(true);
        expect(result.backupPath).toBe(`${configPath}.bak.1`);
      });
    });

    it("fails when no backup exists", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");

        const result = await restoreConfigBackup(configPath);

        expect(result.success).toBe(false);
        expect(result.error).toContain("No backup found");
      });
    });

    it("fails when explicit backup path does not exist, even if other backups exist", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create current config and a backup
        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup" }), "utf-8");

        // Request a non-existent backup path explicitly
        const result = await restoreConfigBackup(configPath, {
          backupPath: `${configPath}.bak.nonexistent`,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Backup not found");
        expect(result.error).toContain(".bak.nonexistent");

        // Verify original content unchanged
        const current = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(current.token).toBe("current");
      });
    });

    it("dry run does not modify config", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const original = { token: "current" };

        await fs.writeFile(configPath, JSON.stringify(original), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup" }), "utf-8");

        const result = await restoreConfigBackup(configPath, { dryRun: true });

        expect(result.success).toBe(true);

        // Verify original content unchanged
        const current = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(current.token).toBe("current");
      });
    });

    it("creates safety backup before restore", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        await fs.writeFile(configPath, JSON.stringify({ token: "current" }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ token: "backup" }), "utf-8");

        await restoreConfigBackup(configPath);

        // Check that a .failed-* file was created
        const dir = path.dirname(configPath);
        const entries = await fs.readdir(dir);
        const failedBackups = entries.filter((e) => e.includes(".failed-"));

        expect(failedBackups.length).toBe(1);
      });
    });
  });

  describe("attemptConfigRollback", () => {
    it("restores from newest valid backup", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid current config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // Create valid backup
        await fs.writeFile(
          `${configPath}.bak`,
          JSON.stringify({ gateway: { port: 18789 } }),
          "utf-8",
        );

        const result = await attemptConfigRollback(configPath);

        expect(result.restored).toBe(true);
        expect(result.backupPath).toBe(`${configPath}.bak`);

        // Verify restored config
        const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(restored.gateway.port).toBe(18789);
      });
    });

    it("tries next backup if first is invalid JSON", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid current config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // Create invalid backup (should be skipped)
        await fs.writeFile(`${configPath}.bak`, "{ also invalid", "utf-8");

        // Create valid numbered backup
        await fs.writeFile(
          `${configPath}.bak.1`,
          JSON.stringify({ gateway: { port: 18789 } }),
          "utf-8",
        );

        const result = await attemptConfigRollback(configPath);

        expect(result.restored).toBe(true);
        expect(result.backupPath).toBe(`${configPath}.bak.1`);
      });
    });

    it("returns error when no valid backup found", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // No backups

        const result = await attemptConfigRollback(configPath);

        expect(result.restored).toBe(false);
        expect(result.error).toContain("No backup found");
      });
    });

    it("returns error when all backups are invalid", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid current config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // Create invalid backups
        await fs.writeFile(`${configPath}.bak`, "{ invalid 1", "utf-8");
        await fs.writeFile(`${configPath}.bak.1`, "{ invalid 2", "utf-8");

        const result = await attemptConfigRollback(configPath);

        expect(result.restored).toBe(false);
        expect(result.error).toContain("No valid backup found");
      });
    });

    it("creates safety backup of failed config before rollback", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid current config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // Create valid backup (must pass schema validation)
        await fs.writeFile(
          `${configPath}.bak`,
          JSON.stringify({ gateway: { port: 18789 } }),
          "utf-8",
        );

        await attemptConfigRollback(configPath);

        // Check that a .failed-* file was created
        const dir = path.dirname(configPath);
        const entries = await fs.readdir(dir);
        const failedBackups = entries.filter((e) => e.includes(".failed-"));

        expect(failedBackups.length).toBe(1);
      });
    });

    it("skips backup that fails schema validation", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create invalid current config
        await fs.writeFile(configPath, "{ invalid json", "utf-8");

        // Create backup with valid JSON but invalid schema (invalid port type)
        await fs.writeFile(
          `${configPath}.bak`,
          JSON.stringify({ gateway: { port: "not-a-number" } }),
          "utf-8",
        );

        // Create backup with valid schema
        await fs.writeFile(
          `${configPath}.bak.1`,
          JSON.stringify({ gateway: { port: 18789 } }),
          "utf-8",
        );

        const result = await attemptConfigRollback(configPath);

        expect(result.restored).toBe(true);
        expect(result.backupPath).toBe(`${configPath}.bak.1`);

        // Verify restored config
        const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(restored.gateway.port).toBe(18789);
      });
    });
  });

  describe("cleanupFailedBackups", () => {
    it("removes old failed backups", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create some failed backups - need to set actual mtime, not just filename timestamp
        const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
        const oldFile = `${configPath}.failed-${oldTimestamp}`;
        await fs.writeFile(oldFile, "{}", "utf-8");
        // Set mtime to 8 days ago so cleanup sees it as old
        await fs.utimes(oldFile, new Date(oldTimestamp), new Date(oldTimestamp));

        await fs.writeFile(`${configPath}.failed-${Date.now()}`, "{}", "utf-8");

        const cleaned = await cleanupFailedBackups(configPath, 7 * 24 * 60 * 60 * 1000);

        expect(cleaned).toBe(1);

        // Verify recent failed backup still exists
        const dir = path.dirname(configPath);
        const entries = await fs.readdir(dir);
        const failedBackups = entries.filter((e) => e.includes(".failed-"));

        expect(failedBackups.length).toBe(1);
      });
    });

    it("returns 0 when no failed backups exist", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, "{}", "utf-8");

        const cleaned = await cleanupFailedBackups(configPath);

        expect(cleaned).toBe(0);
      });
    });
  });

  describe("getBackupStats", () => {
    it("returns correct statistics", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create config and backups
        await fs.writeFile(configPath, JSON.stringify({ a: 1 }), "utf-8");
        await fs.writeFile(`${configPath}.bak`, JSON.stringify({ b: 2 }), "utf-8");

        await new Promise((r) => setTimeout(r, 10));
        await fs.writeFile(`${configPath}.bak.1`, JSON.stringify({ c: 3 }), "utf-8");

        const stats = await getBackupStats(configPath);

        expect(stats.totalBackups).toBe(2);
        expect(stats.totalSize).toBeGreaterThan(0);
        expect(stats.newestBackup).toBeInstanceOf(Date);
        expect(stats.oldestBackup).toBeInstanceOf(Date);
      });
    });

    it("returns zeros when no backups exist", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        await fs.writeFile(configPath, "{}", "utf-8");

        const stats = await getBackupStats(configPath);

        expect(stats.totalBackups).toBe(0);
        expect(stats.totalSize).toBe(0);
        expect(stats.newestBackup).toBeUndefined();
        expect(stats.oldestBackup).toBeUndefined();
      });
    });
  });

  describe("integration tests", () => {
    it("full backup and restore cycle", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Initial config
        const initialConfig: OpenClawConfig = { gateway: { port: 18789 } };
        await fs.writeFile(configPath, JSON.stringify(initialConfig), "utf-8");

        // Create backup
        const backup = await createConfigBackup(configPath, { timestamp: false });
        expect(backup.path).toBe(`${configPath}.bak`);

        // Modify config
        const modifiedConfig: OpenClawConfig = { gateway: { port: 18889 } };
        await fs.writeFile(configPath, JSON.stringify(modifiedConfig), "utf-8");

        // Restore from backup
        const result = await restoreConfigBackup(configPath);
        expect(result.success).toBe(true);

        // Verify restored content matches initial
        const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(restored.gateway.port).toBe(18789);
      });
    });

    it("list backups shows correct order", async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create multiple backups
        await fs.writeFile(configPath, JSON.stringify({ v: 1 }), "utf-8");
        await createConfigBackup(configPath, { timestamp: false });

        await new Promise((r) => setTimeout(r, 20));
        await fs.writeFile(configPath, JSON.stringify({ v: 2 }), "utf-8");
        await fs.copyFile(configPath, `${configPath}.bak.1`);

        await new Promise((r) => setTimeout(r, 20));
        await fs.writeFile(configPath, JSON.stringify({ v: 3 }), "utf-8");
        await fs.copyFile(configPath, `${configPath}.bak.2`);

        const backups = await listConfigBackups(configPath);

        expect(backups.length).toBe(3);
        // Newest first by mtime: .bak.2 (v:3), .bak.1 (v:2), .bak (v:1)
        const contents = await Promise.all(
          backups.map(async (b) => {
            const content = await fs.readFile(b.path, "utf-8");
            return JSON.parse(content).v;
          }),
        );

        // Files sorted by mtime: .bak.2 newest (v:3), then .bak.1 (v:2), then .bak oldest (v:1)
        expect(contents[0]).toBe(3); // .bak.2 has v:3 and newest mtime
        expect(contents[1]).toBe(2); // .bak.1 has v:2
        expect(contents[2]).toBe(1); // .bak has v:1 and oldest mtime
      });
    });
  });
});
