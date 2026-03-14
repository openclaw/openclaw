import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
  formatBackupTimestamp,
} from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  it("creates datetime-suffixed backups for config writes", async () => {
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

      // Simulate 6 writes with distinct timestamps
      const timestamps = [
        new Date("2026-03-08T14:30:20Z"),
        new Date("2026-03-08T14:30:21Z"),
        new Date("2026-03-08T14:30:22Z"),
        new Date("2026-03-08T14:30:23Z"),
        new Date("2026-03-08T14:30:24Z"),
        new Date("2026-03-08T14:30:25Z"),
      ];

      await writeVersion(0);
      for (let version = 1; version <= 6; version += 1) {
        await rotateConfigBackups(configPath, fs, timestamps[version - 1]);
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

      // Current config has latest version
      await expect(readName()).resolves.toBe("v6");
      // Primary .bak has the previous version
      await expect(readName(".bak")).resolves.toBe("v5");
      // Timestamped backups exist (most recent timestamp holds oldest data that was .bak)
      await expect(readName(".bak.20260308-143025")).resolves.toBe("v4");
      await expect(readName(".bak.20260308-143024")).resolves.toBe("v3");
      await expect(readName(".bak.20260308-143023")).resolves.toBe("v2");
      await expect(readName(".bak.20260308-143022")).resolves.toBe("v1");
    });
  });

  it("handles sub-second collision with numeric fallback suffix", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const sameTime = new Date("2026-03-08T14:30:22Z");

      // Create initial .bak and a pre-existing backup with the same timestamp
      await fs.writeFile(`${configPath}.bak`, "first");
      await rotateConfigBackups(configPath, fs, sameTime);

      // First call created .bak.20260308-143022
      await expect(fs.readFile(`${configPath}.bak.20260308-143022`, "utf-8")).resolves.toBe(
        "first",
      );

      // Now create another .bak and rotate with the same timestamp
      await fs.writeFile(`${configPath}.bak`, "second");
      await rotateConfigBackups(configPath, fs, sameTime);

      // Collision fallback: .bak.20260308-143022-1
      await expect(fs.readFile(`${configPath}.bak.20260308-143022-1`, "utf-8")).resolves.toBe(
        "second",
      );
    });
  });

  it("formatBackupTimestamp generates YYYYMMDD-HHmmss in UTC", () => {
    const ts = formatBackupTimestamp(new Date("2026-03-08T14:30:22Z"));
    expect(ts).toBe("20260308-143022");

    // Verify zero-padding
    const ts2 = formatBackupTimestamp(new Date("2026-01-02T03:04:05Z"));
    expect(ts2).toBe("20260102-030405");
  });

  // chmod is a no-op on Windows — 0o600 can never be observed there.
  it.skipIf(IS_WINDOWS)(
    "hardenBackupPermissions sets 0o600 on all backup files by scanning directory",
    async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();

        // Create .bak and a datetime-suffixed backup with permissive mode
        await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
        await fs.writeFile(`${configPath}.bak.20260308-143022`, "secret", { mode: 0o644 });

        await hardenBackupPermissions(configPath, fs);

        const bakStat = await fs.stat(`${configPath}.bak`);
        const bakTsStat = await fs.stat(`${configPath}.bak.20260308-143022`);

        expectPosixMode(bakStat.mode, 0o600);
        expectPosixMode(bakTsStat.mode, 0o600);
      });
    },
  );

  it("cleanOrphanBackups removes orphans and enforces keep-N limit", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      // Create valid backups: primary .bak + 4 datetime-suffixed (N-1 = 4)
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "backup-primary");
      await fs.writeFile(`${configPath}.bak.20260308-143022`, "backup-ts1");
      await fs.writeFile(`${configPath}.bak.20260308-143023`, "backup-ts2");
      await fs.writeFile(`${configPath}.bak.20260308-143024`, "backup-ts3");
      await fs.writeFile(`${configPath}.bak.20260308-143025`, "backup-ts4");

      // Create orphans (non-datetime, non-legacy)
      await fs.writeFile(`${configPath}.bak.before-marketing`, "orphan-manual");

      await cleanOrphanBackups(configPath, fs);

      // Primary .bak untouched (not managed by cleanOrphanBackups)
      await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
      // All 4 datetime backups preserved (within N-1 limit)
      await expect(fs.stat(`${configPath}.bak.20260308-143022`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143023`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143024`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143025`)).resolves.toBeDefined();

      // Orphan removed
      await expect(fs.stat(`${configPath}.bak.before-marketing`)).rejects.toThrow();

      // Main config untouched
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("current");
    });
  });

  it("cleanOrphanBackups enforces keep-N by deleting oldest datetime backups", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "primary");
      // 6 datetime backups (exceeds N-1 = 4 limit)
      await fs.writeFile(`${configPath}.bak.20260308-143020`, "ts0");
      await fs.writeFile(`${configPath}.bak.20260308-143021`, "ts1");
      await fs.writeFile(`${configPath}.bak.20260308-143022`, "ts2");
      await fs.writeFile(`${configPath}.bak.20260308-143023`, "ts3");
      await fs.writeFile(`${configPath}.bak.20260308-143024`, "ts4");
      await fs.writeFile(`${configPath}.bak.20260308-143025`, "ts5");

      await cleanOrphanBackups(configPath, fs);

      // 4 most recent kept
      await expect(fs.stat(`${configPath}.bak.20260308-143025`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143024`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143023`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143022`)).resolves.toBeDefined();

      // 2 oldest deleted
      await expect(fs.stat(`${configPath}.bak.20260308-143021`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.20260308-143020`)).rejects.toThrow();
    });
  });

  it("cleanOrphanBackups preserves legacy numeric backups during migration", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "primary");
      // Legacy numeric backups from old rotation scheme
      await fs.writeFile(`${configPath}.bak.1`, "legacy-1");
      await fs.writeFile(`${configPath}.bak.2`, "legacy-2");
      // Plus 2 new datetime backups
      await fs.writeFile(`${configPath}.bak.20260308-143024`, "ts1");
      await fs.writeFile(`${configPath}.bak.20260308-143025`, "ts2");

      await cleanOrphanBackups(configPath, fs);

      // Total = 4 (2 datetime + 2 legacy), within N-1 = 4 limit: all preserved
      await expect(fs.stat(`${configPath}.bak.20260308-143025`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143024`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.1`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.2`)).resolves.toBeDefined();
    });
  });

  it("cleanOrphanBackups trims legacy files when total exceeds keep-N", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();

      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "primary");
      // 3 legacy + 3 datetime = 6 total, exceeds N-1 = 4
      await fs.writeFile(`${configPath}.bak.1`, "legacy-1");
      await fs.writeFile(`${configPath}.bak.2`, "legacy-2");
      await fs.writeFile(`${configPath}.bak.3`, "legacy-3");
      await fs.writeFile(`${configPath}.bak.20260308-143022`, "ts1");
      await fs.writeFile(`${configPath}.bak.20260308-143023`, "ts2");
      await fs.writeFile(`${configPath}.bak.20260308-143024`, "ts3");

      await cleanOrphanBackups(configPath, fs);

      // Datetime backups take priority (most recent first), then legacy by numeric order
      // Keep: 20260308-143024, 20260308-143023, 20260308-143022, 1
      // Delete: 2, 3
      await expect(fs.stat(`${configPath}.bak.20260308-143024`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143023`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.20260308-143022`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.1`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.2`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.3`)).rejects.toThrow();
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

      // Prior primary backup gets rotated into a timestamped slot.
      const dir = (await fs.readdir(require("node:path").dirname(configPath))).filter(
        (f: string) => f.includes(".bak.") && /\d{8}-\d{6}/.test(f),
      );
      expect(dir.length).toBeGreaterThanOrEqual(1);
      // Read the timestamped file and verify it has the old content
      const tsFile = dir[0];
      await expect(
        fs.readFile(
          require("node:path").join(require("node:path").dirname(configPath), tsFile),
          "utf-8",
        ),
      ).resolves.toBe("previous");

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
});
