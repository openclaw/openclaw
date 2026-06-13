// Covers best-effort config IO reads and warning behavior.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readBestEffortConfig,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("readBestEffortConfig", () => {
  it("can read snapshots without updating config observation state", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });

      await readConfigFileSnapshot({ observe: false });

      const healthPath = `${home}/.openclaw/logs/config-health.json`;
      await expect(fs.stat(healthPath)).rejects.toMatchObject({ code: "ENOENT" });

      await readConfigFileSnapshot();

      await expect(fs.stat(healthPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    });
  });

  it("does not restore suspicious direct edits from .bak during ordinary reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      await fs.copyFile(configPath, `${configPath}.bak`);
      const directEditRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fs.writeFile(configPath, directEditRaw, "utf-8");

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig).toEqual({ update: { channel: "beta" } });
      expect(await fs.readFile(configPath, "utf-8")).toBe(directEditRaw);
      const entries = await fs.readdir(`${home}/.openclaw`);
      expect(entries.some((entry) => entry.startsWith("openclaw.json.clobbered."))).toBe(false);
    });
  });

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

  it("keeps plugin-owned web search config on startup snapshots without recreating legacy scoped fields", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: false,
              config: {
                webSearch: {
                  apiKey: "test-gemini-key",
                  model: "gemini-2.5-flash",
                },
              },
            },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const sourceSearch = snapshot.sourceConfig.tools?.web?.search;
      const runtimeSearch = snapshot.runtimeConfig.tools?.web?.search;

      expect(snapshot.valid).toBe(true);
      expect(sourceSearch).toEqual({
        enabled: true,
        provider: "gemini",
      });
      expect(runtimeSearch).toEqual({
        enabled: true,
        provider: "gemini",
      });
      expect(snapshot.runtimeConfig.plugins?.entries?.google?.config?.webSearch).toEqual({
        apiKey: "test-gemini-key",
        model: "gemini-2.5-flash",
      });
      expect(snapshot.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "plugins.entries.google",
            message: "plugin disabled (disabled in config) but config is present",
          }),
        ]),
      );
      expect("gemini" in (sourceSearch ?? {})).toBe(false);
      expect("gemini" in (runtimeSearch ?? {})).toBe(false);
    });
  });

  it("does not materialize tools.web.search when only plugin-owned web search config exists", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        plugins: {
          entries: {
            google: {
              enabled: false,
              config: {
                webSearch: {
                  apiKey: "test-gemini-key",
                  model: "gemini-2.5-flash",
                },
              },
            },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.tools?.web?.search).toBeUndefined();
      expect(snapshot.runtimeConfig.tools?.web?.search).toBeUndefined();
      expect(snapshot.runtimeConfig.plugins?.entries?.google?.config?.webSearch).toEqual({
        apiKey: "test-gemini-key",
        model: "gemini-2.5-flash",
      });
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
