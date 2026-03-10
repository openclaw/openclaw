import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  loadConfig,
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
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

describe("runtime config snapshot writes", () => {
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
        clearRuntimeConfigSnapshot();
        clearConfigCache();
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
});
