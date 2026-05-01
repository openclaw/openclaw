import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_BACKUP_COUNT,
  BACKUP_DATETIME_RE,
  formatBackupTimestamp,
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
} from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { withTempHome } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

describe("config backup rotation", () => {
  describe("formatBackupTimestamp", () => {
    it("produces a lexicographically sortable UTC datetime string", () => {
      const d = new Date("2026-03-08T14:30:22.456Z");
      expect(formatBackupTimestamp(d)).toBe("20260308-143022456");
    });

    it("pads single-digit fields correctly", () => {
      const d = new Date("2026-01-02T03:04:05.007Z");
      expect(formatBackupTimestamp(d)).toBe("20260102-030405007");
    });

    it("sorts lexicographically in the same order as chronologically", () => {
      const earlier = formatBackupTimestamp(new Date("2026-01-01T00:00:00.000Z"));
      const later = formatBackupTimestamp(new Date("2026-12-31T23:59:59.999Z"));
      expect(earlier < later).toBe(true);
    });

    it("matches BACKUP_DATETIME_RE", () => {
      const ts = formatBackupTimestamp(new Date("2026-03-08T14:30:22.456Z"));
      expect(BACKUP_DATETIME_RE.test(ts)).toBe(true);
    });
  });

  it("keeps a 5-deep backup ring with datetime suffixes", async () => {
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

      // Use fixed timestamps so expected filenames are deterministic
      const timestamps = Array.from(
        { length: 6 },
        (_, i) => new Date(Date.UTC(2026, 0, 1, 10 + i, 0, 0, 0)),
      );

      await writeVersion(0);
      for (let i = 0; i < 6; i += 1) {
        await rotateConfigBackups(configPath, fs, timestamps[i]);
        await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {
          // best-effort
        });
        await cleanOrphanBackups(configPath, fs);
        await writeVersion(i + 1);
      }

      // Trace after 6 iterations (CONFIG_BACKUP_COUNT = 5, keep 4 datetime backups):
      //   i=0: rotate no-ops (.bak absent), copy v0→.bak, write v1
      //   i=1: .bak(v0)→.bak.ts1, copy v1→.bak, write v2    → dt: [ts1(v0)]
      //   i=2: .bak(v1)→.bak.ts2, copy v2→.bak, write v3    → dt: [ts1(v0), ts2(v1)]
      //   i=3: .bak(v2)→.bak.ts3, copy v3→.bak, write v4    → dt: [ts1..ts3]
      //   i=4: .bak(v3)→.bak.ts4, copy v4→.bak, write v5    → dt: [ts1..ts4] (all kept)
      //   i=5: .bak(v4)→.bak.ts5, copy v5→.bak, write v6    → dt: [ts1..ts5], prune ts1
      // Final: .bak=v5, ts5=v4, ts4=v3, ts3=v2, ts2=v1, ts1=DELETED

      const readName = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (
          (JSON.parse(raw) as { agents?: { list?: Array<{ id?: string }> } }).agents?.list?.[0]
            ?.id ?? null
        );
      };

      const ts = (i: number) => `.bak.${formatBackupTimestamp(timestamps[i])}`;

      await expect(readName()).resolves.toBe("v6");
      await expect(readName(".bak")).resolves.toBe("v5");
      await expect(readName(ts(5))).resolves.toBe("v4");
      await expect(readName(ts(4))).resolves.toBe("v3");
      await expect(readName(ts(3))).resolves.toBe("v2");
      await expect(readName(ts(2))).resolves.toBe("v1");
      // ts(1) was the oldest and got pruned; ts(0) was never created (no .bak on i=0)
      await expect(fs.stat(`${configPath}${ts(1)}`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}${ts(0)}`)).rejects.toThrow();
    });
  });

  // chmod is a no-op on Windows — 0o600 can never be observed there.
  it.skipIf(IS_WINDOWS)(
    "hardenBackupPermissions sets 0o600 on .bak and datetime-stamped backups",
    async () => {
      await withTempHome(async () => {
        const configPath = resolveConfigPathFromTempState();
        const ts1 = "20260308-100000000";

        await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
        await fs.writeFile(`${configPath}.bak.${ts1}`, "secret", { mode: 0o644 });

        await hardenBackupPermissions(configPath, fs);

        const bakStat = await fs.stat(`${configPath}.bak`);
        const bak1Stat = await fs.stat(`${configPath}.bak.${ts1}`);

        expectPosixMode(bakStat.mode, 0o600);
        expectPosixMode(bak1Stat.mode, 0o600);
      });
    },
  );

  it("cleanOrphanBackups removes non-datetime .bak.* files (including legacy numeric)", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const ts1 = "20260308-100000000";
      const ts2 = "20260308-110000000";

      // Valid: primary .bak and datetime-stamped backups
      await fs.writeFile(configPath, "current");
      await fs.writeFile(`${configPath}.bak`, "backup-primary");
      await fs.writeFile(`${configPath}.bak.${ts1}`, "backup-dt1");
      await fs.writeFile(`${configPath}.bak.${ts2}`, "backup-dt2");

      // Orphans: legacy numeric, PID-stamped, manual copy, overflow
      await fs.writeFile(`${configPath}.bak.1`, "orphan-legacy");
      await fs.writeFile(`${configPath}.bak.1772352289`, "orphan-pid");
      await fs.writeFile(`${configPath}.bak.before-marketing`, "orphan-manual");
      await fs.writeFile(`${configPath}.bak.99`, "orphan-overflow");

      await cleanOrphanBackups(configPath, fs);

      // Valid backups preserved
      await expect(fs.stat(`${configPath}.bak`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.${ts1}`)).resolves.toBeDefined();
      await expect(fs.stat(`${configPath}.bak.${ts2}`)).resolves.toBeDefined();

      // All orphans removed (legacy numeric included)
      await expect(fs.stat(`${configPath}.bak.1`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.1772352289`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.before-marketing`)).rejects.toThrow();
      await expect(fs.stat(`${configPath}.bak.99`)).rejects.toThrow();

      // Main config untouched
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("current");
    });
  });

  it("cleanOrphanBackups enforces CONFIG_BACKUP_COUNT-1 limit on datetime backups", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      // Create more datetime backups than the limit allows
      const dates = Array.from(
        { length: CONFIG_BACKUP_COUNT + 1 },
        (_, i) => new Date(Date.UTC(2026, 0, 1, i, 0, 0, 0)),
      );
      for (const d of dates) {
        await fs.writeFile(`${configPath}.bak.${formatBackupTimestamp(d)}`, d.toISOString());
      }

      await cleanOrphanBackups(configPath, fs);

      const entries = await fs.readdir(path.dirname(configPath));
      const bakDtEntries = entries.filter((e) => e.startsWith(`${path.basename(configPath)}.bak.`));
      expect(bakDtEntries).toHaveLength(CONFIG_BACKUP_COUNT - 1);

      // Oldest should be deleted
      await expect(
        fs.stat(`${configPath}.bak.${formatBackupTimestamp(dates[0])}`),
      ).rejects.toThrow();
      // Most recent should be kept
      await expect(
        fs.stat(`${configPath}.bak.${formatBackupTimestamp(dates[dates.length - 1])}`),
      ).resolves.toBeDefined();
    });
  });

  it("maintainConfigBackups composes rotate/copy/harden/prune flow", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const now = new Date("2026-03-08T14:30:22.000Z");
      const ts = formatBackupTimestamp(now);

      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });
      await fs.writeFile(`${configPath}.bak.orphan`, "old");

      await maintainConfigBackups(configPath, fs, now);

      // New primary backup is created from the current config
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets a datetime-stamped slot
      await expect(fs.readFile(`${configPath}.bak.${ts}`, "utf-8")).resolves.toBe("previous");
      if (!IS_WINDOWS) {
        const primaryStat = await fs.stat(`${configPath}.bak`);
        expectPosixMode(primaryStat.mode, 0o600);
        const datetimeStat = await fs.stat(`${configPath}.bak.${ts}`);
        expectPosixMode(datetimeStat.mode, 0o600);
      }
      // Out-of-ring orphan gets pruned
      await expect(fs.stat(`${configPath}.bak.orphan`)).rejects.toThrow();
    });
  });
});
