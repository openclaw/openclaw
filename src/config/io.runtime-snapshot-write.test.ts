import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  loadConfig,
  projectConfigOntoRuntimeSourceSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import type { OpenClawConfig } from "./types.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("does not overwrite a runtime snapshot installed after a queued write starts", async () => {
    await withTempHome("openclaw-config-runtime-late-snapshot-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf8");

      const renameEntered = createDeferred();
      const allowRename = createDeferred();
      const originalRename = fsSync.promises.rename.bind(fsSync.promises);
      let blockedFinalRename = false;

      const renameSpy = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (from, to) => {
        if (
          !blockedFinalRename &&
          typeof from === "string" &&
          from.endsWith(".tmp") &&
          to === configPath
        ) {
          blockedFinalRename = true;
          renameEntered.resolve();
          await allowRename.promise;
        }
        return await originalRename(from, to);
      });

      const sourceConfig = createSourceConfig();
      const runtimeConfig: OpenClawConfig = {
        ...createRuntimeConfig(),
        gateway: { auth: { mode: "token" as const } },
      };

      try {
        const writePromise = writeConfigFile({ gateway: { mode: "local", port: 18789 } });
        await renameEntered.promise;

        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

        allowRename.resolve();
        await writePromise;

        expect(getRuntimeConfigSnapshot()).toEqual(runtimeConfig);
        expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
        expect(loadConfig()).toEqual(runtimeConfig);
      } finally {
        renameSpy.mockRestore();
        resetRuntimeConfigState();
      }
    });
  });

  it("does not call a refresh handler installed after a queued write starts", async () => {
    await withTempHome("openclaw-config-runtime-late-handler-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf8");

      const renameEntered = createDeferred();
      const allowRename = createDeferred();
      const originalRename = fsSync.promises.rename.bind(fsSync.promises);
      let blockedFinalRename = false;

      const renameSpy = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (from, to) => {
        if (
          !blockedFinalRename &&
          typeof from === "string" &&
          from.endsWith(".tmp") &&
          to === configPath
        ) {
          blockedFinalRename = true;
          renameEntered.resolve();
          await allowRename.promise;
        }
        return await originalRename(from, to);
      });

      const sourceConfig = createSourceConfig();
      const runtimeConfig = createRuntimeConfig();
      const refreshCalls: OpenClawConfig[] = [];

      try {
        const writePromise = writeConfigFile({ gateway: { mode: "local", port: 18789 } });
        await renameEntered.promise;

        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: async ({ sourceConfig: refreshedSource }) => {
            refreshCalls.push(refreshedSource);
            setRuntimeConfigSnapshot(
              {
                ...runtimeConfig,
                gateway: { auth: { mode: "token" as const } },
              },
              refreshedSource,
            );
            return true;
          },
        });

        allowRename.resolve();
        await writePromise;

        expect(refreshCalls).toEqual([]);
        expect(getRuntimeConfigSnapshot()).toEqual(runtimeConfig);
        expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
      } finally {
        renameSpy.mockRestore();
        resetRuntimeConfigState();
      }
    });
  });
});
