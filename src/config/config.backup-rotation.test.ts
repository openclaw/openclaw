import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  maintainConfigBackups,
  rotateConfigBackups,
  hardenBackupPermissions,
  cleanOrphanBackups,
} from "./backup-rotation.js";
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

  it.runIf(process.platform !== "win32")(
    "hardenBackupPermissions sets 0o600 on all backup files",
    async () => {
      await withTempHome(async () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
        if (!stateDir) {
          throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
        }
        const configPath = path.join(stateDir, "openclaw.json");

        // Create .bak and .bak.1 with permissive mode
        await fs.writeFile(`${configPath}.bak`, "secret", { mode: 0o644 });
        await fs.writeFile(`${configPath}.bak.1`, "secret", { mode: 0o644 });

        await hardenBackupPermissions(configPath, fs);

        const bakStat = await fs.stat(`${configPath}.bak`);
        const bak1Stat = await fs.stat(`${configPath}.bak.1`);

<<<<<<< HEAD
      // Windows does not reliably honor POSIX chmod bits.
      if (process.platform === "win32") {
        expect(bakStat.mode & 0o777).toBeGreaterThan(0);
        expect(bak1Stat.mode & 0o777).toBeGreaterThan(0);
      } else {
        expect(bakStat.mode & 0o777).toBe(0o600);
        expect(bak1Stat.mode & 0o777).toBe(0o600);
      }
    });
  });
=======
        // Owner-only permissions (0o600)
        expect(bakStat.mode & 0o777).toBe(0o600);
        expect(bak1Stat.mode & 0o777).toBe(0o600);
      });
    },
  );
>>>>>>> 9e6b69edc (test: skip file permission tests on Windows)

  it("cleanOrphanBackups removes stale files outside the rotation ring", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
      if (!stateDir) {
        throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
      }
      const configPath = path.join(stateDir, "openclaw.json");

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

  it.runIf(process.platform !== "win32")(
    "maintainConfigBackups composes rotate/copy/harden/prune flow",
    async () => {
      await withTempHome(async () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
        if (!stateDir) {
          throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
        }
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
        await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });
        await fs.writeFile(`${configPath}.bak.orphan`, "old");

        await maintainConfigBackups(configPath, fs);

<<<<<<< HEAD
      // A new primary backup is created from the current config.
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets rotated into ring slot 1.
      await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
      // Mode hardening still applies on POSIX systems.
      const primaryBackupStat = await fs.stat(`${configPath}.bak`);
      if (process.platform === "win32") {
        expect(primaryBackupStat.mode & 0o777).toBeGreaterThan(0);
      } else {
        expect(primaryBackupStat.mode & 0o777).toBe(0o600);
      }
      // Out-of-ring orphan gets pruned.
      await expect(fs.stat(`${configPath}.bak.orphan`)).rejects.toThrow();
    });
  });
=======
        // A new primary backup is created from the current config.
        await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
          JSON.stringify({ token: "secret" }),
        );
        // Prior primary backup gets rotated into ring slot 1.
        await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
        // Mode hardening still applies.
        const primaryBackupStat = await fs.stat(`${configPath}.bak`);
        expect(primaryBackupStat.mode & 0o777).toBe(0o600);
        // Out-of-ring orphan gets pruned.
        await expect(fs.stat(`${configPath}.bak.orphan`)).rejects.toThrow();
      });
    },
  );
>>>>>>> 9e6b69edc (test: skip file permission tests on Windows)
});
