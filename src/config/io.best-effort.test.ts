import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
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
import { withTempHome, withTempHomeConfig } from "./test-helpers.js";

function resolutionWarning(configPath: string) {
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(readCurrentConfigForResolution({ configPath }).config).toEqual({});
  return warn.mock.calls.map(([line]) => String(line)).join("\n");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetConfigOverrides();
});

const cachePruningConfig = {
  auth: { profiles: { "anthropic:api": { provider: "anthropic", mode: "api_key" as const } } },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
};

it("records why an unparseable config was ignored by best-effort reads", async () => {
  await withTempHome(async (home) => {
    await fs.mkdir(`${home}/.openclaw`, { recursive: true });
    await fs.writeFile(`${home}/.openclaw/openclaw.json`, "{ definitely not json", "utf-8");
    using warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await readSourceConfigBestEffort()).toEqual({});
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).includes("best-effort read ignored unparseable config"),
      ),
    ).toBe(true);
  });
});

it("preserves Windows case-insensitive env lookup in isolated reads", async () => {
  await withTempHome(async (home) => {
    const mixedCaseKey = "OpenClaw_Config_Path";
    const customConfigPath = `${home}/custom-openclaw.json`;
    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: undefined, [mixedCaseKey]: customConfigPath },
      async () => {
        using _ = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        await fs.writeFile(customConfigPath, '{"gateway":{"mode":"local"}}\n', "utf-8");

        const snapshot = await readConfigFileSnapshot({ isolateEnv: true, observe: false });

        expect(snapshot).toMatchObject({ exists: true, path: customConfigPath });
      },
    );
  });
});

it("does not restore suspicious direct edits from .bak during ordinary reads", async () => {
  await withTempHomeConfig(
    {
      meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
      update: { channel: "beta" },
      gateway: { mode: "local" },
    },
    async ({ home, configPath }) => {
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
    },
  );
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
  await withTempHomeConfig(cachePruningConfig, async () => {
    const snapshot = await readConfigFileSnapshot();
    const bestEffort = await readBestEffortConfig();
    const sourceBestEffort = await readSourceConfigBestEffort();
    expect(sourceBestEffort).toEqual(snapshot.sourceConfigBeforeMigrations);
    expect(sourceBestEffort.agents?.defaults?.contextPruning?.mode).toBeUndefined();
    expect(sourceBestEffort.agents?.defaults?.compaction?.mode).toBeUndefined();

    expect(snapshot.config.agents?.defaults).toMatchObject({
      contextPruning: { mode: "cache-ttl" },
      compaction: { mode: "safeguard" },
    });

    expect(bestEffort.agents?.defaults).toMatchObject({
      contextPruning: { mode: "cache-ttl", ttl: "1h" },
      compaction: { mode: "safeguard" },
      models: { "anthropic/claude-opus-4-6": { params: { cacheRetention: "short" } } },
    });
  });
});

it("returns invalid config diagnostics with the best-effort fallback", async () => {
  await withTempHomeConfig({ gateway: { port: "abc" } }, async ({ configPath }) => {
    expect((await readBestEffortConfigSnapshot({ observe: false })).configDiagnostics).toEqual({
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
const unavailable = "Config unavailable; using environment and default agent directory settings.";
const malformedRedaction = (entry: number | null) => ({
  name: `malformed redaction ${entry}`,
  config: {
    logging: { redactPatterns: [entry] },
    skills: { workshop: { approvalPolicy: "pending", maxPending: 3 } },
  },
  messages: ["Config warnings:", unavailable, "logging.redactPatterns"],
});
it.each([
  malformedRedaction(1),
  malformedRedaction(null),
  {
    name: "invalid port",
    config: { gateway: { port: "abc" } },
    messages: ["Config unavailable", "expected number, received string"],
  },
])("explains rejection for $name", async ({ config, messages }) => {
  await withTempHomeConfig(config, async ({ configPath }) => {
    const warning = resolutionWarning(configPath);
    for (const message of messages) {
      expect(warning).toContain(message);
    }
  });
});

it("keeps the plain availability warning for an absent config file", async () => {
  await withTempHome(async (home) => {
    const configPath = `${home}/.openclaw/absent.json`;
    expect(resolutionWarning(configPath)).toContain(`${configPath}: ${unavailable}`);
  });
});
