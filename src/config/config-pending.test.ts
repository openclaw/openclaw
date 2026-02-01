import fs from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTempHome } from "./test-helpers.js";

// We need to dynamically import the module after setting up the temp home
// because the module reads paths at import time

describe("config-pending", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("writePendingMarker", () => {
    it("creates pending marker and pre-restart snapshot", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const bakPath = path.join(stateDir, "openclaw.json.bak");

        // Create initial config
        await fs.writeFile(configPath, JSON.stringify({ version: "original" }), "utf-8");

        const { writePendingMarker } = await import("./config-pending.js");
        await writePendingMarker({ reason: "test", timeoutMs: 5000 });

        // Check marker was created
        const marker = JSON.parse(await fs.readFile(markerPath, "utf-8"));
        expect(marker.reason).toBe("test");
        expect(marker.timeoutMs).toBe(5000);
        expect(marker.appliedAt).toBeDefined();

        // Check pre-restart snapshot was saved
        const bak = JSON.parse(await fs.readFile(bakPath, "utf-8"));
        expect(bak.version).toBe("original");
      });
    });

    it("uses verified config as rollback target when available", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const verifiedPath = path.join(stateDir, "openclaw.json.verified");
        const markerPath = path.join(stateDir, "config-pending.json");

        // Create config and verified
        await fs.writeFile(configPath, JSON.stringify({ version: "current" }), "utf-8");
        await fs.writeFile(verifiedPath, JSON.stringify({ version: "verified" }), "utf-8");

        const { writePendingMarker } = await import("./config-pending.js");
        await writePendingMarker({ reason: "test" });

        const marker = JSON.parse(await fs.readFile(markerPath, "utf-8"));
        expect(marker.rollbackTo).toBe(verifiedPath);
        expect(marker.preRestartSnapshot).toContain(".bak");
      });
    });

    it("falls back to .bak when no verified config exists", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");

        await fs.writeFile(configPath, JSON.stringify({ version: "current" }), "utf-8");

        const { writePendingMarker } = await import("./config-pending.js");
        await writePendingMarker({ reason: "first-run" });

        const marker = JSON.parse(await fs.readFile(markerPath, "utf-8"));
        expect(marker.rollbackTo).toContain(".bak");
      });
    });
  });

  describe("clearPendingMarker", () => {
    it("removes the pending marker file", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const markerPath = path.join(stateDir, "config-pending.json");

        await fs.writeFile(markerPath, JSON.stringify({ test: true }), "utf-8");

        const { clearPendingMarker } = await import("./config-pending.js");
        await clearPendingMarker();

        await expect(fs.access(markerPath)).rejects.toThrow();
      });
    });

    it("does not throw if marker does not exist", async () => {
      await withTempHome(async () => {
        const { clearPendingMarker } = await import("./config-pending.js");
        await expect(clearPendingMarker()).resolves.not.toThrow();
      });
    });
  });

  describe("markConfigVerified", () => {
    it("saves current config to .verified", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const verifiedPath = path.join(stateDir, "openclaw.json.verified");

        await fs.writeFile(configPath, JSON.stringify({ version: "good" }), "utf-8");

        const { markConfigVerified } = await import("./config-pending.js");
        await markConfigVerified();

        const verified = JSON.parse(await fs.readFile(verifiedPath, "utf-8"));
        expect(verified.version).toBe("good");
      });
    });
  });

  describe("checkPendingOnStartup", () => {
    it("returns rolledBack: false when no marker exists", async () => {
      await withTempHome(async () => {
        const { checkPendingOnStartup } = await import("./config-pending.js");
        const result = await checkPendingOnStartup();
        expect(result.rolledBack).toBe(false);
      });
    });

    it("clears marker and returns rolledBack: false when elapsed > timeout", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const bakPath = path.join(stateDir, "openclaw.json.bak");

        // Create config and backup
        await fs.writeFile(configPath, JSON.stringify({ version: "new" }), "utf-8");
        await fs.writeFile(bakPath, JSON.stringify({ version: "old" }), "utf-8");

        // Create marker with old timestamp (success scenario)
        const oldTime = new Date(Date.now() - 60000).toISOString(); // 60s ago
        await fs.writeFile(
          markerPath,
          JSON.stringify({
            appliedAt: oldTime,
            rollbackTo: bakPath,
            timeoutMs: 30000,
          }),
          "utf-8",
        );

        const { checkPendingOnStartup } = await import("./config-pending.js");
        const result = await checkPendingOnStartup();

        expect(result.rolledBack).toBe(false);
        // Marker should be cleared
        await expect(fs.access(markerPath)).rejects.toThrow();
        // Config should NOT be changed
        const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(config.version).toBe("new");
      });
    });

    it("rolls back when elapsed < timeout (crash detected)", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const verifiedPath = path.join(stateDir, "openclaw.json.verified");
        const failedPath = path.join(stateDir, "openclaw.json.failed");

        // Create config (the "crashed" one) and verified backup
        await fs.writeFile(configPath, JSON.stringify({ version: "crashed" }), "utf-8");
        await fs.writeFile(verifiedPath, JSON.stringify({ version: "verified-good" }), "utf-8");

        // Create marker with recent timestamp (crash scenario)
        const recentTime = new Date(Date.now() - 1000).toISOString(); // 1s ago
        await fs.writeFile(
          markerPath,
          JSON.stringify({
            appliedAt: recentTime,
            rollbackTo: verifiedPath,
            timeoutMs: 30000,
            reason: "test-crash",
          }),
          "utf-8",
        );

        const { checkPendingOnStartup } = await import("./config-pending.js");
        const result = await checkPendingOnStartup();

        expect(result.rolledBack).toBe(true);
        expect(result.reason).toBe("test-crash");

        // Config should be restored from verified
        const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(config.version).toBe("verified-good");

        // Failed config should be saved
        const failed = JSON.parse(await fs.readFile(failedPath, "utf-8"));
        expect(failed.version).toBe("crashed");

        // Marker should be cleared
        await expect(fs.access(markerPath)).rejects.toThrow();
      });
    });

    it("appends to rollback history on rollback", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const verifiedPath = path.join(stateDir, "openclaw.json.verified");
        const historyPath = path.join(stateDir, "config-rollback-history.json");

        await fs.writeFile(configPath, JSON.stringify({ version: "crashed" }), "utf-8");
        await fs.writeFile(verifiedPath, JSON.stringify({ version: "good" }), "utf-8");

        const recentTime = new Date(Date.now() - 500).toISOString();
        await fs.writeFile(
          markerPath,
          JSON.stringify({
            appliedAt: recentTime,
            rollbackTo: verifiedPath,
            timeoutMs: 30000,
            reason: "history-test",
          }),
          "utf-8",
        );

        const { checkPendingOnStartup } = await import("./config-pending.js");
        await checkPendingOnStartup();

        const history = JSON.parse(await fs.readFile(historyPath, "utf-8"));
        expect(Array.isArray(history)).toBe(true);
        expect(history.length).toBe(1);
        expect(history[0].reason).toBe("history-test");
        expect(history[0].elapsedMs).toBeLessThan(30000);
      });
    });
  });

  describe("dist rollback marker integration", () => {
    it("writePendingMarker includes distBackupPath when backup dir exists", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const distBackupDir = path.join(stateDir, "dist.bak");

        await fs.writeFile(configPath, JSON.stringify({ version: "test" }), "utf-8");
        await fs.mkdir(distBackupDir, { recursive: true });
        await fs.writeFile(path.join(distBackupDir, "marker.txt"), "backup exists", "utf-8");

        const { writePendingMarker } = await import("./config-pending.js");
        await writePendingMarker({ includeDistRollback: true });

        const marker = JSON.parse(await fs.readFile(markerPath, "utf-8"));
        expect(marker.distBackupPath).toBe(distBackupDir);
      });
    });

    it("writePendingMarker omits distBackupPath when no backup exists", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");

        await fs.writeFile(configPath, JSON.stringify({ version: "test" }), "utf-8");

        const { writePendingMarker } = await import("./config-pending.js");
        await writePendingMarker({ includeDistRollback: true });

        const marker = JSON.parse(await fs.readFile(markerPath, "utf-8"));
        expect(marker.distBackupPath).toBeUndefined();
      });
    });

    it("rollback history includes distRolledBack flag when dist backup specified", async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const markerPath = path.join(stateDir, "config-pending.json");
        const verifiedPath = path.join(stateDir, "openclaw.json.verified");
        const historyPath = path.join(stateDir, "config-rollback-history.json");
        const distBackupDir = path.join(stateDir, "dist.bak");

        await fs.writeFile(configPath, JSON.stringify({ version: "crashed" }), "utf-8");
        await fs.writeFile(verifiedPath, JSON.stringify({ version: "good" }), "utf-8");
        await fs.mkdir(distBackupDir, { recursive: true });
        await fs.writeFile(path.join(distBackupDir, "test.js"), "// backup content", "utf-8");

        // Create a temp target dir for dist rollback (avoids wiping real dist/)
        const distTargetDir = path.join(home, "fake-dist-target");
        await fs.mkdir(distTargetDir, { recursive: true });

        const recentTime = new Date(Date.now() - 500).toISOString();
        await fs.writeFile(
          markerPath,
          JSON.stringify({
            appliedAt: recentTime,
            rollbackTo: verifiedPath,
            distBackupPath: distBackupDir,
            timeoutMs: 30000,
          }),
          "utf-8",
        );

        const { checkPendingOnStartup } = await import("./config-pending.js");
        const result = await checkPendingOnStartup({ distTargetDir });

        expect(result.rolledBack).toBe(true);
        expect(result.distRolledBack).toBe(true);

        // Verify the backup was restored to the target dir
        const restoredContent = await fs.readFile(path.join(distTargetDir, "test.js"), "utf-8");
        expect(restoredContent).toBe("// backup content");

        const history = JSON.parse(await fs.readFile(historyPath, "utf-8"));
        expect(history[0]).toHaveProperty("distRolledBack");
        expect(history[0].distRolledBack).toBe(true);
      });
    });
  });

  describe("backupDist", () => {
    it("copies source directory to backup location", async () => {
      await withTempHome(async (home) => {
        const sourceDir = path.join(home, "fake-dist");
        const backupDir = path.join(home, "dist-backup");

        // Create source with files
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.writeFile(path.join(sourceDir, "index.js"), "console.log('hello');", "utf-8");
        await fs.mkdir(path.join(sourceDir, "lib"), { recursive: true });
        await fs.writeFile(path.join(sourceDir, "lib", "utils.js"), "export {};", "utf-8");

        const { backupDist } = await import("./config-pending.js");
        const result = await backupDist(sourceDir, backupDir);

        expect(result).toBe(backupDir);

        // Verify backup contains files
        const indexContent = await fs.readFile(path.join(backupDir, "index.js"), "utf-8");
        expect(indexContent).toBe("console.log('hello');");
        const utilsContent = await fs.readFile(path.join(backupDir, "lib", "utils.js"), "utf-8");
        expect(utilsContent).toBe("export {};");
      });
    });

    it("removes old backup before creating new one", async () => {
      await withTempHome(async (home) => {
        const sourceDir = path.join(home, "fake-dist");
        const backupDir = path.join(home, "dist-backup");

        // Create old backup with different content
        await fs.mkdir(backupDir, { recursive: true });
        await fs.writeFile(path.join(backupDir, "old-file.js"), "old content", "utf-8");

        // Create new source
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.writeFile(path.join(sourceDir, "new-file.js"), "new content", "utf-8");

        const { backupDist } = await import("./config-pending.js");
        await backupDist(sourceDir, backupDir);

        // Old file should be gone
        await expect(fs.access(path.join(backupDir, "old-file.js"))).rejects.toThrow();
        // New file should exist
        const newContent = await fs.readFile(path.join(backupDir, "new-file.js"), "utf-8");
        expect(newContent).toBe("new content");
      });
    });

    it("returns null if source does not exist", async () => {
      await withTempHome(async (home) => {
        const { backupDist } = await import("./config-pending.js");
        const result = await backupDist(path.join(home, "nonexistent"), path.join(home, "backup"));
        expect(result).toBeNull();
      });
    });
  });

  describe("restoreDist", () => {
    it("copies backup to target directory", async () => {
      await withTempHome(async (home) => {
        const backupDir = path.join(home, "backup");
        const targetDir = path.join(home, "restored");

        // Create backup
        await fs.mkdir(backupDir, { recursive: true });
        await fs.writeFile(path.join(backupDir, "restored.js"), "restored content", "utf-8");

        // Create target with different content (will be replaced)
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "old.js"), "old content", "utf-8");

        const { restoreDist } = await import("./config-pending.js");
        const result = await restoreDist(backupDir, targetDir);

        expect(result).toBe(true);

        // Old file should be gone
        await expect(fs.access(path.join(targetDir, "old.js"))).rejects.toThrow();
        // Restored file should exist
        const content = await fs.readFile(path.join(targetDir, "restored.js"), "utf-8");
        expect(content).toBe("restored content");
      });
    });

    it("returns false if backup does not exist", async () => {
      await withTempHome(async (home) => {
        const { restoreDist } = await import("./config-pending.js");
        const result = await restoreDist(path.join(home, "nonexistent"), path.join(home, "target"));
        expect(result).toBe(false);
      });
    });
  });
});
