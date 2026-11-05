/** Integration tests for auth-profile secret runtime preparation. */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import type { SecretRef } from "../config/types.secrets.js";
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
  resolveRuntimeWebTools: async () => ({
    metadata: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
    degradedOwners: [],
    secretOwners: [],
  }),
}));

vi.mock("./runtime-owner-assignments.js", () => ({
  listSecretAssignmentOwners: () => [],
  resolveAndApplySecretAssignments: async () => ({
    degradedOwners: [],
    resolvedValues: new Map(),
  }),
}));

function loadAuthStoreFromTestFile(agentDir?: string): AuthProfileStore {
  if (!agentDir) {
    return { version: 1, profiles: {} };
  }
  try {
    const raw = readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8");
    return JSON.parse(raw) as AuthProfileStore;
  } catch {
    return { version: 1, profiles: {} };
  }
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
      const opsKeyRef = { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" } as const;
      const writeProfile = async (
        agentDir: string,
        id: string,
        provider: string,
        keyRef: SecretRef,
      ) => {
        await fs.mkdir(agentDir, { recursive: true });
        const profiles = { [id]: { type: "api_key", provider, keyRef } };
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      };
      await writeProfile(mainAgentDir, "openai:default", "openai", OPENAI_ENV_KEY_REF);
      await writeProfile(opsAgentDir, "anthropic:ops", "anthropic", opsKeyRef);
      const options = {
        env: { OPENAI_API_KEY: "sk-main-runtime", ANTHROPIC_API_KEY: "sk-ops-runtime" },
        loadAuthStore: loadAuthStoreFromTestFile,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      };

      const prepared = await prepareSecretsRuntimeSnapshot({
        ...options,
        config: asConfig({}),
      });

      activateSecretsRuntimeSnapshot(prepared);
      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores.find(
          (entry) => entry.agentDir === opsAgentDir,
        ),
      ).toBeUndefined();

      const refreshed = await prepareSecretsRuntimeSnapshot({
        ...options,
        config: asConfig({ agents: { entries: { ops: { agentDir: opsAgentDir } } } }),
      });
      activateSecretsRuntimeSnapshot(refreshed);

      const profile = getActiveSecretsRuntimeSnapshot()?.authStores.find(
        (entry) => entry.agentDir === opsAgentDir,
      )?.store.profiles["anthropic:ops"];
      expect(profile).toEqual(
        expect.objectContaining({ type: "api_key", key: "sk-ops-runtime", keyRef: opsKeyRef }),
      );
    });
  });
});
