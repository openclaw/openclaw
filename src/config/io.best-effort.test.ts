import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBestEffortConfig,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("readBestEffortConfig", () => {
  it("reuses valid snapshots while preserving load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const bestEffort = await readBestEffortConfig();

      expect(snapshot.config.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBeUndefined();

      expect(bestEffort.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(bestEffort.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(bestEffort.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(
        bestEffort.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
      ).toBe("short");
    });
  });

  it("can read diagnostics config without writing read-side state", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        commands: { ownerDisplay: "hash" },
        gateway: { mode: "local" },
      });
      const healthStatePath = path.join(home, ".openclaw", "logs", "config-health.json");
      const before = await fs.readFile(configPath, "utf-8");

      const bestEffort = await readBestEffortConfig({ readOnly: true });

      expect(bestEffort.gateway?.mode).toBe("local");
      expect(bestEffort.commands?.ownerDisplaySecret).toEqual(expect.any(String));
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(before);
      await expect(fs.stat(healthStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("readSourceConfigBestEffort", () => {
  it("preserves the authored source config without load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const sourceBestEffort = await readSourceConfigBestEffort();

      expect(sourceBestEffort).toEqual(snapshot.resolved);
      expect(sourceBestEffort.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(sourceBestEffort.agents?.defaults?.compaction?.mode).toBeUndefined();
    });
  });
});
