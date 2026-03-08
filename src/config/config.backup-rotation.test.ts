import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
  isDatetimeSuffix,
} from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  it("rotates .bak into a datetime-stamped file", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "old-backup");

      await rotateConfigBackups(configPath, fs);

      // Primary .bak should no longer exist (renamed to datetime stamp)
      await expect(fs.stat(`${configPath}.bak`)).rejects.toThrow();

      // A datetime-stamped backup should exist
      const dir = path.dirname(configPath);
      const base = path.basename(configPath);
      const entries = await fs.readdir(dir);
      const stamped = entries.filter(
        (e) => e.startsWith(`${base}.bak.`) && isDatetimeSuffix(e.slice(`${base}.bak.`.length)),
      );
      expect(stamped).toHaveLength(1);

      // Content should match the old backup
      const content = await fs.readFile(path.join(dir, stamped[0]), "utf-8");
      expect(content).toBe("old-backup");
    });
  });

  it("keeps a 5-deep backup ring for config writes", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const dir = path.dirname(configPath);
      const base = path.basename(configPath);

      const buildConfig = (version: number): OpenClawConfig =>
        ({
          agents: { list: [{ id: `v${version}` }] },
        }) as OpenClawConfig;

      const writeVersion = async (version: number) => {
        const json = JSON.stringify(buildConfig(version), null, 2).trimEnd().concat("\n");
        await fs.writeFile(configPath, json, "utf-8");
      };

      // Simulate 6 config writes with rotation + cleanup each time
      await writeVersion(0);
      for (let version = 1; version <= 6; version += 1) {
        await rotateConfigBackups(configPath, fs);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});
        await cleanOrphanBackups(configPath, fs);
        await writeVersion(version);
      }

      // Current config should be v6
      const raw = await fs.readFile(configPath, "utf-8");
      const current = (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents
        ?.list?.[0]?.id;
      expect(current).toBe("v6");

      // Primary .bak should exist
      const bakRaw = await fs.readFile(`${configPath}.bak`, "utf-8");
      const bakVersion = (JSON.parse(bakRaw) as { agents?: { list?: Array<{ id?: string }> } })
        .agents?.list?.[0]?.id;
      expect(bakVersion).toBe("v5");

      // Should have exactly CONFIG_BACKUP_COUNT - 1 = 4 datetime-stamped backups
      const entries = await fs.readdir(dir);
      const stamped = entries.filter(
        (e) => e.startsWith(`${base}.bak.`) && isDatetimeSuffix(e.slice(`${base}.bak.`.length)),
      );
      expect(stamped).toHaveLength(4);

      // No .bak.5 or numbered files should exist
      await expect(fs.stat(`${configPath}.bak.5`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.1`)).rejects.toThrow();
    });
  });

  // chmod is a no-op on Windows — 0o600 can never be observed there.
  it.skipIf(IS_WINDOWS)("hardenBackupPermissions sets 0o600 on all backup files", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create .bak and a datetime-stamped backup with permissive mode
      await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.20260308-143022`, "secret", { mode: 0o644 });

      await hardenBackupPermissions(configPath, fs);

      const bakStat = await fs.stat(`${configPath}.bak`);
      const stampedStat = await fs.stat(`${configPath}.bak.20260308-143022`);

      expectPosixMode(bakStat.mode, 0o600);
      expectPosixMode(stampedStat.mode, 0o600);
    });
  });

  it("cleanOrphanBackups removes legacy numbered and stale files", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create valid backups
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "backup-primary");
      await fs.writeFile(`${configPath}.bak.20260301-100000`, "datetime-1");
      await fs.writeFile(`${configPath}.bak.20260302-100000`, "datetime-2");

      // Create orphans: legacy numbered, PID-stamped, manual
      await fs.writeFile(`${configPath}.bak.1`, "legacy-numbered");
      await fs.writeFile(`${configPath}.bak.2`, "legacy-numbered-2");
      await fs.writeFile(`${configPath}.bak.1772352289`, "orphan-pid");
      await fs.writeFile(`${configPath}.bak.before-marketing`, "orphan-manual");

      await cleanOrphanBackups(configPath, fs);

      // Primary .bak preserved (not touched by cleanOrphanBackups)
      await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
      // Datetime backups preserved
      await expect(fs.stat(`${configPath}.bak.20260301-100000`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260302-100000`)).resolves.toBeDefined();

      // Legacy numbered backups removed
      await expect(fs.stat(`${configPath}.bak.1`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.2`)).rejects.toThrow();

      // Other orphans removed
      await expect(fs.stat(`${configPath}.bak.1772352289`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.before-marketing`)).rejects.toThrow();

      // Main config untouched
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("current");
    });
  });

  it("cleanOrphanBackups enforces capacity limit on datetime backups", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "primary");

      // Create 6 datetime backups (exceeds CONFIG_BACKUP_COUNT - 1 = 4)
      await fs.writeFile(`${configPath}.bak.20260101-100000`, "jan");
      await fs.writeFile(`${configPath}.bak.20260201-100000`, "feb");
      await fs.writeFile(`${configPath}.bak.20260301-100000`, "mar");
      await fs.writeFile(`${configPath}.bak.20260401-100000`, "apr");
      await fs.writeFile(`${configPath}.bak.20260501-100000`, "may");
      await fs.writeFile(`${configPath}.bak.20260601-100000`, "jun");

      await cleanOrphanBackups(configPath, fs);

      // Oldest 2 should be removed (keep 4 most recent)
      await expect(fs.stat(`${configPath}.bak.20260101-100000`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.20260201-100000`)).rejects.toThrow();

      // 4 most recent preserved
      await expect(fs.stat(`${configPath}.bak.20260301-100000`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260401-100000`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260501-100000`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260601-100000`)).resolves.toBeDefined();
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

      const dir = path.dirname(configPath);
      const base = path.basename(configPath);
      const entries = await fs.readdir(dir);

      // Prior primary backup gets rotated into a datetime-stamped slot.
      const stamped = entries.filter(
        (e) => e.startsWith(`${base}.bak.`) && isDatetimeSuffix(e.slice(`${base}.bak.`.length)),
      );
      expect(stamped).toHaveLength(1);
      const rotatedContent = await fs.readFile(path.join(dir, stamped[0]), "utf-8");
      expect(rotatedContent).toBe("previous");

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

  describe("isDatetimeSuffix", () => {
    it("matches valid datetime suffixes", () => {
      expect(isDatetimeSuffix("20260308-143022")).toBe(true);
      expect(isDatetimeSuffix("20260308-143022-02")).toBe(true);
      expect(isDatetimeSuffix("20260308-143022-15")).toBe(true);
    });

    it("rejects non-datetime suffixes", () => {
      expect(isDatetimeSuffix("1")).toBe(false);
      expect(isDatetimeSuffix("99")).toBe(false);
      expect(isDatetimeSuffix("1772352289")).toBe(false);
      expect(isDatetimeSuffix("before-marketing")).toBe(false);
      expect(isDatetimeSuffix("orphan")).toBe(false);
    });

    it("rejects collision suffixes the code never produces", () => {
      expect(isDatetimeSuffix("20260308-143022-0")).toBe(false);
      expect(isDatetimeSuffix("20260308-143022-1")).toBe(false);
    });
  });
});
