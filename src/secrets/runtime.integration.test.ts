import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore, type AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearConfigCache,
  loadConfig,
  type OpenClawConfig,
  writeConfigFile,
} from "../config/config.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveRuntimeWebToolsMetadata,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

const OPENAI_ENV_KEY_REF = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
const OPENAI_FILE_KEY_REF = {
  source: "file",
  provider: "default",
  id: "/providers/openai/apiKey",
} as const;
const allowInsecureTempSecretFile = process.platform === "win32";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

async function createOpenAIFileRuntimeFixture(home: string) {
  const configDir = path.join(home, ".openclaw");
  const secretFile = path.join(configDir, "secrets.json");
  const agentDir = path.join(configDir, "agents", "main", "agent");
  const authStorePath = path.join(agentDir, "auth-profiles.json");

  await fs.mkdir(agentDir, { recursive: true });
  await fs.chmod(configDir, 0o700).catch(() => {});
  await fs.writeFile(
    secretFile,
    `${JSON.stringify({ providers: { openai: { apiKey: "sk-file-runtime" } } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    configDir,
    secretFile,
    agentDir,
  };
}

function createOpenAIFileRuntimeConfig(secretFile: string): OpenClawConfig {
  return asConfig({
    secrets: {
      providers: {
        default: {
          source: "file",
          path: secretFile,
          mode: "json",
          ...(allowInsecureTempSecretFile ? { allowInsecurePath: true } : {}),
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: OPENAI_FILE_KEY_REF,
          models: [],
        },
      },
    },
  });
}

function expectResolvedOpenAIRuntime(agentDir: string) {
  expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-file-runtime");
  expect(ensureAuthProfileStore(agentDir).profiles["openai:default"]).toMatchObject({
    type: "api_key",
    key: "sk-file-runtime",
  });
}

describe("secrets runtime snapshot integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
      "OPENCLAW_VERSION",
    ]);
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
    delete process.env.OPENCLAW_VERSION;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    clearSecretsRuntimeSnapshot();
    clearConfigCache();
  });

  it("activates runtime snapshots for loadConfig and ensureAuthProfileStore", async () => {
    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_VERSION: undefined,
      },
      async () => {
        const prepared = await prepareSecretsRuntimeSnapshot({
          config: asConfig({
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () =>
            loadAuthStoreWithProfiles({
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: OPENAI_ENV_KEY_REF,
              },
            }),
        });

        activateSecretsRuntimeSnapshot(prepared);

        expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
        expect(
          ensureAuthProfileStore("/tmp/openclaw-agent-main").profiles["openai:default"],
        ).toMatchObject({
          type: "api_key",
          key: "sk-runtime",
        });
      },
    );
  });

  it("keeps active secrets runtime snapshots resolved after config writes", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-write-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
      });

      activateSecretsRuntimeSnapshot(prepared);

      expectResolvedOpenAIRuntime(agentDir);

      await writeConfigFile({
        ...loadConfig(),
        gateway: { auth: { mode: "token" } },
      });

      expect(loadConfig().gateway?.auth).toEqual({ mode: "token" });
      expectResolvedOpenAIRuntime(agentDir);
    });
  });

  it("keeps last-known-good runtime snapshot active when refresh fails after a write", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-fail-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);

      let loadAuthStoreCalls = 0;
      const loadAuthStore = () => {
        loadAuthStoreCalls += 1;
        if (loadAuthStoreCalls > 1) {
          throw new Error("simulated secrets runtime refresh failure");
        }
        return loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        });
      };

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadAuthStore,
      });

      activateSecretsRuntimeSnapshot(prepared);

      await expect(
        writeConfigFile({
          ...loadConfig(),
          gateway: { auth: { mode: "token" } },
        }),
      ).rejects.toThrow(
        /runtime snapshot refresh failed: simulated secrets runtime refresh failure/i,
      );

      const activeAfterFailure = getActiveSecretsRuntimeSnapshot();
      expect(activeAfterFailure).not.toBeNull();
      expect(loadConfig().gateway?.auth).toBeUndefined();
      expectResolvedOpenAIRuntime(agentDir);
      expect(activeAfterFailure?.sourceConfig.models?.providers?.openai?.apiKey).toEqual(
        OPENAI_FILE_KEY_REF,
      );
    });
  });

  it("keeps last-known-good web runtime snapshot when reload introduces unresolved active web refs", async () => {
    await withTempHome("openclaw-secrets-runtime-web-reload-lkg-", async (home) => {
      const prepared = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          tools: {
            web: {
              search: {
                provider: "gemini",
                gemini: {
                  apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_GEMINI_API_KEY" },
                },
              },
            },
          },
        }),
        env: {
          WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-runtime-key",
        },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });

      activateSecretsRuntimeSnapshot(prepared);

      await expect(
        writeConfigFile({
          ...loadConfig(),
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
                    },
                  },
                },
              },
            },
          },
          tools: {
            web: {
              search: {
                provider: "gemini",
                gemini: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        }),
      ).rejects.toThrow(
        /runtime snapshot refresh failed: .*WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK/i,
      );

      const activeAfterFailure = getActiveSecretsRuntimeSnapshot();
      expect(activeAfterFailure).not.toBeNull();
      expect(loadConfig().tools?.web?.search?.gemini?.apiKey).toBe("web-search-gemini-runtime-key");
      expect(activeAfterFailure?.sourceConfig.tools?.web?.search?.gemini?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "WEB_SEARCH_GEMINI_API_KEY",
      });
      expect(getActiveRuntimeWebToolsMetadata()?.search.selectedProvider).toBe("gemini");

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"),
      ) as OpenClawConfig;
      const persistedGoogleWebSearchConfig = persistedConfig.plugins?.entries?.google?.config as
        | { webSearch?: { apiKey?: unknown } }
        | undefined;
      expect(persistedGoogleWebSearchConfig?.webSearch?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
      });
    });
  }, 180_000);

  it("recomputes config-derived agent dirs when refreshing active secrets runtime snapshots", async () => {
    await withTempHome("openclaw-secrets-runtime-agent-dirs-", async (home) => {
      const mainAgentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const opsAgentDir = path.join(home, ".openclaw", "agents", "ops", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(opsAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.writeFile(
        path.join(opsAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:ops": {
                type: "api_key",
                provider: "anthropic",
                keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {
          OPENAI_API_KEY: "sk-main-runtime",
          ANTHROPIC_API_KEY: "sk-ops-runtime",
        },
      });

      activateSecretsRuntimeSnapshot(prepared);
      expect(ensureAuthProfileStore(opsAgentDir).profiles["anthropic:ops"]).toBeUndefined();

      await writeConfigFile({
        agents: {
          list: [{ id: "ops", agentDir: opsAgentDir }],
        },
      });

      expect(ensureAuthProfileStore(opsAgentDir).profiles["anthropic:ops"]).toMatchObject({
        type: "api_key",
        key: "sk-ops-runtime",
        keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      });
    });
  });
});
