import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  ConfigRuntimeRefreshError,
  createConfigIO,
  getRuntimeConfigSnapshot,
  loadConfig,
  readBestEffortConfig,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

function createSourceConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [],
        },
      },
    },
  };
}

function createRuntimeConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-runtime-resolved",
          models: [],
        },
      },
    },
  };
}

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

afterEach(() => {
  resetRuntimeConfigState();
});

describe("config io wrapper helpers", () => {
  it("returns normalized loadConfig output from readBestEffortConfig when the snapshot is valid", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 9_000,
            },
          },
        },
      });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_DISABLE_CONFIG_CACHE: "1" },
        async () => {
          const snapshot = await readConfigFileSnapshot();
          const bestEffort = await readBestEffortConfig();

          expect(snapshot.valid).toBe(true);
          expect(snapshot.config.agents?.defaults?.compaction?.mode).toBeUndefined();
          expect(bestEffort).toEqual(loadConfig());
          expect(bestEffort.agents?.defaults?.compaction?.mode).toBe("safeguard");
        },
      );
    });
  });

  it("returns the snapshot config from readBestEffortConfig when validation fails", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: {
          auth: {
            mode: 42,
          },
        },
      });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_DISABLE_CONFIG_CACHE: "1" },
        async () => {
          const snapshot = await readConfigFileSnapshot();
          const bestEffort = await readBestEffortConfig();

          expect(snapshot.valid).toBe(false);
          expect(bestEffort).toEqual(snapshot.config);
        },
      );
    });
  });

  it("passes through snapshot data in the wrapper exports", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        messages: {
          ackReactionScope: "direct",
        },
      });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_DISABLE_CONFIG_CACHE: "1" },
        async () => {
          const directIo = createConfigIO({ configPath, env: process.env });

          expect(await readConfigFileSnapshot()).toEqual(await directIo.readConfigFileSnapshot());
          expect(await readConfigFileSnapshotForWrite()).toEqual(
            await directIo.readConfigFileSnapshotForWrite(),
          );
        },
      );
    });
  });

  it("wraps runtime refresh failures and preserves the original cause", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, createSourceConfig());
      const sourceConfig = createSourceConfig();
      const runtimeConfig = createRuntimeConfig();

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_DISABLE_CONFIG_CACHE: "1" },
        async () => {
          const failure = new Error("refresh boom");
          const clearOnRefreshFailure = vi.fn();

          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: async () => {
              throw failure;
            },
            clearOnRefreshFailure,
          });

          try {
            await writeConfigFile({
              ...runtimeConfig,
              gateway: {
                auth: {
                  mode: "token",
                },
              },
            });
            throw new Error("Expected writeConfigFile to throw");
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigRuntimeRefreshError);
            expect((error as Error & { cause?: unknown }).cause).toBe(failure);
            expect(String(error)).toContain("refresh boom");
          }

          expect(clearOnRefreshFailure).toHaveBeenCalledTimes(1);
        },
      );
    });
  });

  it("clears runtime-only snapshots after writes so follow-up reads come from disk", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {});

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_DISABLE_CONFIG_CACHE: "1" },
        async () => {
          setRuntimeConfigSnapshot({
            gateway: {
              auth: {
                mode: "token",
              },
            },
          });

          await writeConfigFile({
            logging: {
              redactSensitive: "off",
            },
          });

          expect(getRuntimeConfigSnapshot()).toBeNull();
          expect(loadConfig().logging?.redactSensitive).toBe("off");
          expect(loadConfig().gateway?.auth).toBeUndefined();
        },
      );
    });
  });
});
