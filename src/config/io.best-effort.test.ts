// Covers best-effort config IO reads and warning behavior.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  readBestEffortConfig,
  readBestEffortConfigSnapshot,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { readCurrentConfigForResolution } from "./io.runtime.js";
import { resetConfigOverrides, setConfigOverride } from "./runtime-overrides.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

const cachePruningConfig = {
  auth: { profiles: { "anthropic:api": { provider: "anthropic", mode: "api_key" as const } } },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
};

describe("readBestEffortConfig", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetConfigOverrides();
  });

  it("records why an unparseable config was ignored by best-effort reads", async () => {
    await withTempHome(async (home) => {
      const configPath = `${home}/.openclaw/openclaw.json`;
      await fs.mkdir(`${home}/.openclaw`, { recursive: true });
      await fs.writeFile(configPath, "{ definitely not json", "utf-8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const config = await readSourceConfigBestEffort();

        expect(config).toEqual({});
        expect(
          warn.mock.calls.some(([line]) =>
            String(line).includes("best-effort read ignored unparseable config"),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("preserves Windows case-insensitive env lookup in isolated reads", async () => {
    await withTempHome(async (home) => {
      const mixedCaseKey = "OpenClaw_Config_Path";
      const customConfigPath = `${home}/custom-openclaw.json`;
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined }, async () => {
        await withEnvAsync({ [mixedCaseKey]: customConfigPath }, async () => {
          const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
          try {
            await fs.writeFile(
              customConfigPath,
              `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
              "utf-8",
            );

            const snapshot = await readConfigFileSnapshot({ isolateEnv: true, observe: false });

            expect(snapshot.exists).toBe(true);
            expect(snapshot.path).toBe(customConfigPath);
          } finally {
            platformSpy.mockRestore();
          }
        });
      });
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

      expect(snapshot.sourceConfigBeforeMigrations).toEqual({ update: { channel: "beta" } });
      expect(snapshot.sourceConfig).toEqual({
        update: { channel: "beta" },
        agents: { entries: { main: {} } },
      });
      expect(await fs.readFile(configPath, "utf-8")).toBe(directEditRaw);
      const entries = await fs.readdir(`${home}/.openclaw`);
      expect(entries.some((entry) => entry.startsWith("openclaw.json.clobbered."))).toBe(false);
    });
  });

  it("materializes fresh-install defaults when the config file is missing", async () => {
    await withTempHome(async () => {
      const { loadConfig } = await import("./io.runtime.js");
      expect(setConfigOverride("logging.level", "warn").ok).toBe(true);

      const snapshot = await readConfigFileSnapshot({ observe: false });
      const loaded = loadConfig({ pin: false, skipPluginValidation: true });

      expect(snapshot.exists).toBe(false);
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(loaded.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(loaded.logging?.level).toBe("warn");
    });
  });

  it("keeps authored source separate from materialized best-effort defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, cachePruningConfig);

      const snapshot = await readConfigFileSnapshot();
      const bestEffort = await readBestEffortConfig();
      const sourceBestEffort = await readSourceConfigBestEffort();
      expect(sourceBestEffort).toEqual(snapshot.sourceConfigBeforeMigrations);
      expect(sourceBestEffort.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(sourceBestEffort.agents?.defaults?.compaction?.mode).toBeUndefined();

      expect(snapshot.config.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");

      expect(bestEffort.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(bestEffort.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(bestEffort.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(
        bestEffort.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
      ).toBe("short");
    });
  });

  it("returns invalid config diagnostics with the best-effort fallback", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { port: "abc" },
      } as never);

      const snapshot = await readBestEffortConfigSnapshot({ observe: false });

      expect(snapshot.configDiagnostics).toEqual({
        path: configPath,
        issues: [
          {
            path: "gateway.port",
            message: "Invalid input: expected number, received string",
          },
        ],
      });
    });
  });
});

describe("readCurrentConfigForResolution", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetConfigOverrides();
  });

  it("names the rejection when directory inspection cannot load a schema-invalid config", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { port: "abc" },
      } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const resolution = readCurrentConfigForResolution({ configPath });

        expect(resolution.config).toEqual({});
        const warning = warn.mock.calls.map(([line]) => String(line)).join("\n");
        expect(warning).toContain("Config unavailable");
        // The degraded read must not hide why the file was rejected; doctor repairs the
        // same file moments later, so a bare availability warning is misleading.
        expect(warning).toContain("expected number, received string");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("keeps the plain availability warning for an absent config file", async () => {
    await withTempHome(async (home) => {
      const configPath = `${home}/.openclaw/absent.json`;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const resolution = readCurrentConfigForResolution({ configPath });

        expect(resolution.config).toEqual({});
        const warning = warn.mock.calls.map(([line]) => String(line)).join("\n");
        // Absent files carry no rejection reason, so the warning stays plain.
        expect(warning).toContain(
          `${configPath}: Config unavailable; using environment and default agent directory settings.`,
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
