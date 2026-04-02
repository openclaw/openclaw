import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  getRuntimeConfigSourceSnapshot,
  loadConfig,
  projectConfigOntoRuntimeSourceSnapshot,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
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
          apiKey: "sk-runtime-resolved", // pragma: allowlist secret
          models: [],
        },
      },
    },
  };
}

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime config snapshot writes", () => {
  beforeEach(() => {
    resetRuntimeConfigState();
  });

  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("returns the source snapshot when runtime snapshot is active", async () => {
    await withTempHome("openclaw-config-runtime-source-", async () => {
      const sourceConfig = createSourceConfig();
      const runtimeConfig = createRuntimeConfig();
      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("skips source projection for non-runtime-derived configs", async () => {
    await withTempHome("openclaw-config-runtime-projection-shape-", async () => {
      const sourceConfig: OpenClawConfig = {
        ...createSourceConfig(),
        gateway: {
          auth: {
            mode: "token",
          },
        },
      };
      const runtimeConfig: OpenClawConfig = {
        ...createRuntimeConfig(),
        gateway: {
          auth: {
            mode: "token",
          },
        },
      };
      const independentConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-independent-config", // pragma: allowlist secret
              models: [],
            },
          },
        },
      };

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        const projected = projectConfigOntoRuntimeSourceSnapshot(independentConfig);
        expect(projected).toBe(independentConfig);
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("clears runtime source snapshot when runtime snapshot is cleared", async () => {
    const sourceConfig = createSourceConfig();
    const runtimeConfig = createRuntimeConfig();

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    resetRuntimeConfigState();
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
  });

  it("preserves source secret refs when writeConfigFile receives runtime-resolved config", async () => {
    await withTempHome("openclaw-config-runtime-write-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourceConfig = createSourceConfig();
      const runtimeConfig = createRuntimeConfig();

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime-resolved");

        await writeConfigFile(loadConfig());

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
          models?: { providers?: { openai?: { apiKey?: unknown } } };
        };
        expect(persisted.models?.providers?.openai?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("refreshes the runtime snapshot after writes so follow-up reads see persisted changes", async () => {
    await withTempHome("openclaw-config-runtime-write-refresh-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourceConfig: OpenClawConfig = {
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
      const runtimeConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-runtime-resolved", // pragma: allowlist secret
              models: [],
            },
          },
        },
      };
      const nextRuntimeConfig: OpenClawConfig = {
        ...runtimeConfig,
        gateway: { auth: { mode: "token" as const } },
      };

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        expect(loadConfig().gateway?.auth).toBeUndefined();

        await writeConfigFile(nextRuntimeConfig);

        expect(loadConfig().gateway?.auth).toEqual({ mode: "token" });
        expect(loadConfig().models?.providers?.openai?.apiKey).toBeDefined();

        let persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
          gateway?: { auth?: unknown };
          models?: { providers?: { openai?: { apiKey?: unknown } } };
        };
        expect(persisted.gateway?.auth).toEqual({ mode: "token" });
        // Post-write secret-ref: apiKey must stay as source ref (not plaintext).
        expect(persisted.models?.providers?.openai?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });

        // Follow-up write: runtimeConfigSourceSnapshot must be restored so second write
        // still runs secret-preservation merge-patch and keeps apiKey as ref (not plaintext).
        await writeConfigFile(loadConfig());
        persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
          gateway?: { auth?: unknown };
          models?: { providers?: { openai?: { apiKey?: unknown } } };
        };
        expect(persisted.models?.providers?.openai?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("keeps the last-known-good runtime snapshot active while a specialized refresh is pending", async () => {
    await withTempHome("openclaw-config-runtime-refresh-pending-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourceConfig = createSourceConfig();
      const runtimeConfig = createRuntimeConfig();
      const nextRuntimeConfig: OpenClawConfig = {
        ...runtimeConfig,
        gateway: { auth: { mode: "token" as const } },
      };

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");

      let releaseRefresh!: () => void;
      const refreshPending = new Promise<boolean>((resolve) => {
        releaseRefresh = () => resolve(true);
      });

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: async ({ sourceConfig: refreshedSource }) => {
            expect(refreshedSource.gateway?.auth).toEqual({ mode: "token" });
            expect(loadConfig().gateway?.auth).toBeUndefined();
            return await refreshPending;
          },
        });

        const writePromise = writeConfigFile(nextRuntimeConfig);
        await Promise.resolve();

        expect(loadConfig().gateway?.auth).toBeUndefined();
        releaseRefresh();
        await writePromise;
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("notifies in-process write listeners with the refreshed runtime snapshot", async () => {
    await withTempHome("openclaw-config-runtime-write-listener-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`);

      const seen: Array<{ configPath: string; runtimeConfig: OpenClawConfig }> = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        seen.push({
          configPath: event.configPath,
          runtimeConfig: event.runtimeConfig,
        });
      });

      try {
        expect(loadConfig().gateway?.port).toBe(18789);
        await writeConfigFile({
          ...loadConfig(),
          gateway: { port: 19003 },
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]?.configPath).toBe(configPath);
        expect(seen[0]?.runtimeConfig.gateway?.port).toBe(19003);
      } finally {
        unsubscribe();
        resetRuntimeConfigState();
      }
    });
  });
});
