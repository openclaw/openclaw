import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  loadPersistedAuthProfileStore,
  savePersistedAuthProfileSecretsStore,
} from "../agents/auth-profiles/persisted.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  asConfig,
  beginSecretsRuntimeIsolationForTest,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  OPENAI_ENV_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime-auth.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

vi.mock("./runtime-prepare.runtime.js", () => ({
  createResolverContext: ({
    sourceConfig,
    env,
  }: {
    sourceConfig: unknown;
    env: NodeJS.ProcessEnv;
  }) => ({
    sourceConfig,
    env,
    cache: {},
    warnings: [],
    warningKeys: new Set<string>(),
    assignments: [],
  }),
  collectConfigAssignments: () => {},
  collectAuthStoreAssignments: ({
    store,
    context,
  }: {
    store: AuthProfileStore;
    context: { env: NodeJS.ProcessEnv };
  }) => {
    for (const profile of Object.values(store.profiles)) {
      if (
        profile?.type === "api_key" &&
        profile.keyRef?.source === "env" &&
        typeof profile.keyRef.id === "string"
      ) {
        const key = context.env[profile.keyRef.id];
        if (typeof key === "string" && key.length > 0) {
          profile.key = key;
        }
      }
    }
  },
  resolveSecretRefValues: async () => new Map(),
  applyResolvedAssignments: () => {},
  resolveRuntimeWebTools: async () => ({
    search: { providerSource: "none", diagnostics: [] },
    fetch: { providerSource: "none", diagnostics: [] },
    diagnostics: [],
  }),
}));

function loadAuthStoreFromTestState(agentDir?: string): AuthProfileStore {
  if (!agentDir) {
    return { version: 1, profiles: {} };
  }
  return loadPersistedAuthProfileStore(agentDir) ?? { version: 1, profiles: {} };
}

describe("secrets runtime snapshot auth integration", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("recomputes config-derived agent dirs when refreshing active secrets runtime snapshots", async () => {
    await withTempHome("openclaw-secrets-runtime-agent-dirs-", async (home) => {
      const mainAgentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const opsAgentDir = path.join(home, ".openclaw", "agents", "ops", "agent");
      savePersistedAuthProfileSecretsStore(
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
        mainAgentDir,
      );
      savePersistedAuthProfileSecretsStore(
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
        opsAgentDir,
      );

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {
          OPENAI_API_KEY: "sk-main-runtime",
          ANTHROPIC_API_KEY: "sk-ops-runtime",
        },
        loadAuthStore: loadAuthStoreFromTestState,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      });

      activateSecretsRuntimeSnapshot(prepared);
      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores.find(
          (entry) => entry.agentDir === opsAgentDir,
        ),
      ).toBeUndefined();

      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: {
            list: [{ id: "ops", agentDir: opsAgentDir }],
          },
        }),
        env: {
          OPENAI_API_KEY: "sk-main-runtime",
          ANTHROPIC_API_KEY: "sk-ops-runtime",
        },
        loadAuthStore: loadAuthStoreFromTestState,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      });
      activateSecretsRuntimeSnapshot(refreshed);

      const profile = getActiveSecretsRuntimeSnapshot()?.authStores.find(
        (entry) => entry.agentDir === opsAgentDir,
      )?.store.profiles["anthropic:ops"];
      expect(profile?.type).toBe("api_key");
      if (profile?.type !== "api_key") {
        throw new Error("Expected anthropic ops API key profile");
      }
      expect(profile.key).toBe("sk-ops-runtime");
      expect(profile.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "ANTHROPIC_API_KEY",
      });
    });
  });
});
