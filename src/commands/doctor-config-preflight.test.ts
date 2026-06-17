// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import {
  runDoctorConfigPreflight,
  shouldSkipPluginValidationForDoctorConfigPreflight,
} from "./doctor-config-preflight.js";

describe("runDoctorConfigPreflight", () => {
  it("skips plugin schema validation while doctor is running inside update", () => {
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("collects legacy config issues outside the normal config read path", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
        },
      });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(false);
      expect(preflight.snapshot.legacyIssues.map((issue) => issue.path)).toContain("memorySearch");
      const memorySearch = (
        preflight.baseConfig as {
          memorySearch?: { provider?: unknown; fallback?: unknown };
        }
      ).memorySearch;
      expect(memorySearch?.provider).toBe("local");
      expect(memorySearch?.fallback).toBe("none");
    });
  });

  it("migrates sibling moltbot config when canonical openclaw config is missing (#54200)", async () => {
    await withTempHome(async (home) => {
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19091 } }, null, 2)}\n`,
        "utf-8",
      );

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.config.gateway?.mode).toBe("local");
      await expect(
        fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf-8"),
      ).resolves.toContain('"mode": "local"');
    });
  });

  it("does not overwrite canonical config created during missing-config recovery (#54200)", async () => {
    await withTempHome(async (home) => {
      const targetPath = path.join(home, ".openclaw", "openclaw.json");
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19091 } }, null, 2)}\n`,
        "utf-8",
      );
      const originalCopyFile = fs.copyFile;
      let wroteConcurrentConfig = false;
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const destination = String(args[1]);
        if (!wroteConcurrentConfig && destination.endsWith(".tmp")) {
          wroteConcurrentConfig = true;
          await fs.writeFile(
            targetPath,
            `${JSON.stringify({ gateway: { mode: "remote", port: 19092 } }, null, 2)}\n`,
            "utf-8",
          );
        }
        return originalCopyFile(...args);
      });

      try {
        const preflight = await runDoctorConfigPreflight({
          migrateState: false,
          invalidConfigNote: false,
        });

        expect(preflight.snapshot.valid).toBe(true);
        expect(preflight.snapshot.config.gateway?.mode).toBe("remote");
        await expect(fs.readFile(targetPath, "utf-8")).resolves.toContain('"mode": "remote"');
      } finally {
        copyFileSpy.mockRestore();
      }
    });
  });

  it("leaves skeletal canonical config untouched without repair preflight (#54200)", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { update: { channel: "beta" } });
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19091 } }, null, 2)}\n`,
        "utf-8",
      );

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.config.gateway?.mode).toBeUndefined();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"channel": "beta"');
      const entries = await fs.readdir(path.dirname(configPath));
      expect(
        entries.some((entry) => entry.startsWith("openclaw.json.pre-moltbot-migration.")),
      ).toBe(false);
    });
  });

  it("recovers skeletal canonical config from sibling moltbot config during repair preflight (#54200)", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { update: { channel: "beta" } });
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19091 } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.chmod(legacyPath, 0o644);

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(true);
      expect(preflight.snapshot.config.gateway?.mode).toBe("local");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode": "local"');
      if (process.platform !== "win32") {
        const stat = await fs.stat(configPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      const entries = await fs.readdir(path.dirname(configPath));
      expect(
        entries.some((entry) => entry.startsWith("openclaw.json.pre-moltbot-migration.")),
      ).toBe(true);
    });
  });

  it("does not replace canonical config that already has gateway settings (#54200)", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "remote" },
      });
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19091 } }, null, 2)}\n`,
        "utf-8",
      );

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.config.gateway?.mode).toBe("remote");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode": "remote"');
    });
  });

  it("keeps skeletal canonical config when sibling moltbot copy fails (#54200)", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { update: { channel: "beta" } });
      const legacyPath = path.join(home, ".openclaw", "moltbot.json");
      // A directory cannot be copied as a file, so recovery fails and the skeletal config is kept.
      await fs.mkdir(legacyPath, { recursive: true });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.config.gateway?.mode).toBeUndefined();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"channel": "beta"');
      const entries = await fs.readdir(path.dirname(configPath));
      expect(
        entries.some((entry) => entry.startsWith("openclaw.json.pre-moltbot-migration.")),
      ).toBe(false);
    });
  });

  it("restores invalid config from last-known-good only during repair preflight", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(configPath, "{ invalid json", "utf-8");

      const inspectOnly = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(inspectOnly.snapshot.valid).toBe(false);

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.mode).toBe("local");
      expect(await fs.readFile(configPath, "utf-8")).toBe(lastGoodRaw);
    });
  });

  it("does not restore last-known-good for stale plugins.deny entries", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf-8");

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });

  it("restores last-known-good for malformed plugin policy values", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19092 }, plugins: { deny: "bad" } }, null, 2)}\n`,
        "utf-8",
      );

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19091);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
    });
  });
});
