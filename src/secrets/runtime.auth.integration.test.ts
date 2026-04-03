import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  writeConfigFile,
} from "../config/config.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  asConfig,
  createOpenAIFileRuntimeConfig,
  createOpenAIFileRuntimeFixture,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  expectResolvedOpenAIRuntime,
  loadAuthStoreWithProfiles,
  OPENAI_ENV_KEY_REF,
  OPENAI_FILE_KEY_REF,
} from "./runtime.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

describe("secrets runtime snapshot auth integration", () => {
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
    clearRuntimeConfigSnapshot();
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
                  apiKey: OPENAI_ENV_KEY_REF,
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
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
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
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
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
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
                keyRef: OPENAI_ENV_KEY_REF,
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
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
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
