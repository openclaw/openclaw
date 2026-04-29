import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  createConfigIO,
  resetConfigRuntimeState,
  writeConfigFile as writeConfigFileWithRefresh,
} from "./io.js";
import type { OpenClawConfig } from "./types.js";

const removedPluginId = "google-antigravity-auth";

function configWithRemovedPlugin(port: number, includeAllow = false): OpenClawConfig {
  return {
    gateway: { port },
    plugins: {
      ...(includeAllow ? { allow: [removedPluginId] } : {}),
      entries: {
        [removedPluginId]: {
          enabled: true,
        },
      },
    },
  };
}

function cleanConfig(port: number): OpenClawConfig {
  return {
    gateway: { port },
  };
}

function configWarningMessages(warn: {
  mock: { calls: readonly (readonly unknown[])[] };
}): string[] {
  return warn.mock.calls
    .map(([message]) => message)
    .filter((message): message is string => {
      return typeof message === "string" && message.startsWith("Config warnings:\n");
    });
}

async function writeRawConfig(configPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("config warning log dedupe", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-config-warning-dedupe-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    clearPluginManifestRegistryCache();
    resetConfigRuntimeState();
  });

  afterAll(async () => {
    clearPluginManifestRegistryCache();
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  async function createCaseIo() {
    const home = await suiteRootTracker.make("case");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const warn = vi.fn();
    const error = vi.fn();
    const io = createConfigIO({
      configPath,
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "0",
        OPENCLAW_TEST_FAST: "1",
        VITEST: "true",
      } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: { warn, error },
    });
    return { configPath, io, warn };
  }

  it("deduplicates load warnings and relogs when raw config changes or warnings clear", async () => {
    const { configPath, io, warn } = await createCaseIo();

    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(1);

    await writeRawConfig(configPath, configWithRemovedPlugin(19002));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(2);

    await writeRawConfig(configPath, cleanConfig(19002));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(2);

    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(3);
  });

  it("clears load warning fingerprints on missing, parse-failed, invalid, and early-return states", async () => {
    const { configPath, io, warn } = await createCaseIo();

    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(1);

    await fs.rm(configPath, { force: true });
    expect(io.loadConfig()).toEqual({});
    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(2);

    await fs.writeFile(configPath, '{"plugins":', "utf-8");
    expect(() => io.loadConfig()).toThrow();
    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(3);

    await writeRawConfig(configPath, { gateway: { port: "not-a-number" } });
    expect(() => io.loadConfig()).toThrow();
    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(4);

    await fs.writeFile(configPath, "true\n", "utf-8");
    expect(io.loadConfig()).toEqual({});
    await writeRawConfig(configPath, configWithRemovedPlugin(19001));
    io.loadConfig();
    expect(configWarningMessages(warn)).toHaveLength(5);
  });

  it("deduplicates write warnings and relogs when write content or warning details change", async () => {
    const { io, warn } = await createCaseIo();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    try {
      await io.writeConfigFile(configWithRemovedPlugin(19001));
      await io.writeConfigFile(configWithRemovedPlugin(19001));
      expect(configWarningMessages(warn)).toHaveLength(1);

      await io.writeConfigFile(configWithRemovedPlugin(19002));
      expect(configWarningMessages(warn)).toHaveLength(2);

      await io.writeConfigFile(configWithRemovedPlugin(19002, true));
      expect(configWarningMessages(warn)).toHaveLength(3);

      await io.writeConfigFile(cleanConfig(19002));
      expect(configWarningMessages(warn)).toHaveLength(3);

      await io.writeConfigFile(configWithRemovedPlugin(19002));
      expect(configWarningMessages(warn)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates exported write refresh warnings against the persisted raw config", async () => {
    const home = await suiteRootTracker.make("exported-write");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const stateDir = path.join(home, ".openclaw");
    const previousEnv = {
      HOME: process.env.HOME,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      OPENCLAW_TEST_FAST: process.env.OPENCLAW_TEST_FAST,
      VITEST: process.env.VITEST,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      process.env.HOME = home;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS = "0";
      process.env.OPENCLAW_STATE_DIR = stateDir;
      process.env.OPENCLAW_TEST_FAST = "1";
      process.env.VITEST = "true";
      resetConfigRuntimeState();

      await writeConfigFileWithRefresh(configWithRemovedPlugin(19001));

      expect(configWarningMessages(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
      resetConfigRuntimeState();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
