import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import { runModelsAuthLoginFlowCore } from "../commands/models/auth.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const providerId = "account-relogin-proof";
const pinnedProfileId = `${providerId}:pinned`;
const generatedProfileId = `${providerId}:generated`;
const retainedProfile = { type: "api_key" as const, provider: "other", key: "retained-key" };

function oauthCredential(accountId: string, generation: string): AuthProfileCredential {
  return {
    type: "oauth",
    provider: providerId,
    access: `${generation}-access`,
    refresh: `${generation}-refresh`,
    expires: 2_100_000_000_000,
    accountId,
  };
}

async function writeIdentityProvider(params: {
  workspaceDir: string;
  accountId: string;
  profileId?: string;
  generation?: string;
}) {
  const pluginDir = path.join(params.workspaceDir, ".openclaw", "extensions", providerId);
  await fs.mkdir(pluginDir, { recursive: true, mode: 0o755 });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: providerId,
      providers: [providerId],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(providerId)},
      register(api) {
        api.registerProvider({
          id: ${JSON.stringify(providerId)},
          label: "Account re-login proof",
          auth: [{
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            matchesPersonalAccount(incoming, existing) {
              return incoming.type === "oauth" && existing.type === "oauth" &&
                incoming.provider === existing.provider &&
                incoming.accountId === existing.accountId;
            },
            async run() {
              return { profiles: [{
                profileId: ${JSON.stringify(params.profileId ?? generatedProfileId)},
                credential: {
                  type: "oauth",
                  provider: ${JSON.stringify(providerId)},
                  access: ${JSON.stringify(`${params.generation ?? "new"}-access`)},
                  refresh: ${JSON.stringify(`${params.generation ?? "new"}-refresh`)},
                  expires: 2100000000000,
                  accountId: ${JSON.stringify(params.accountId)},
                },
              }] };
            },
          }],
        });
      },
    };`,
  );
}

type ProofFixture = {
  state: OpenClawTestState;
  config: OpenClawConfig;
  runLogin: (params?: {
    force?: boolean;
    beforePersistentEffect?: () => void | Promise<void>;
  }) => ReturnType<typeof runModelsAuthLoginFlowCore>;
};

async function withProofFixture(
  params: { accountId: string; generation?: string },
  run: (fixture: ProofFixture) => Promise<void>,
): Promise<void> {
  const state = await createOpenClawTestState({
    label: "provider-account-relogin-proof",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_OAUTH_DIR: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
    plugins: { allow: [providerId], entries: { [providerId]: { enabled: true } } },
  };
  try {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    await writeIdentityProvider({
      workspaceDir: state.workspaceDir,
      accountId: params.accountId,
      generation: params.generation,
    });
    await state.writeConfig(config);
    const runLogin: ProofFixture["runLogin"] = (options = {}) =>
      runModelsAuthLoginFlowCore({
        provider: providerId,
        method: "oauth",
        agent: "main",
        config,
        credentialOnly: true,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        prompter: createWizardPrompter(),
        refreshAfterLogin: vi.fn(async () => {}),
        ...options,
      });
    await run({ state, config, runLogin });
  } finally {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearAuthProfileMigrationDiagnostics();
    await state.cleanup();
  }
}

function seedProfiles(
  state: OpenClawTestState,
  profiles: Record<string, AuthProfileCredential>,
): void {
  saveAuthProfileStore({ version: 1, profiles }, state.agentDir(), {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
  clearRuntimeAuthProfileStoreSnapshots();
}

function persistedProfiles(state: OpenClawTestState): Record<string, AuthProfileCredential> {
  return loadPersistedAuthProfileStore(state.agentDir())?.profiles ?? {};
}

describe("provider account re-login through the real persistence adapter", () => {
  it("persists a fresh OAuth login under the provider-generated profile id", async () => {
    await withProofFixture({ accountId: "account-a" }, async ({ state, runLogin }) => {
      seedProfiles(state, { "other:retained": retainedProfile });

      await expect(runLogin()).resolves.toMatchObject({
        profiles: [{ profileId: generatedProfileId, provider: providerId, mode: "oauth" }],
      });
      expect(persistedProfiles(state)).toEqual({
        "other:retained": retainedProfile,
        [generatedProfileId]: oauthCredential("account-a", "new"),
      });
    });
  });

  it("preserves a same-account profile id and keeps an existing conversation usable", async () => {
    await withProofFixture(
      { accountId: "account-a", generation: "rotated" },
      async ({ state, config, runLogin }) => {
        seedProfiles(state, {
          "other:retained": retainedProfile,
          [pinnedProfileId]: oauthCredential("account-a", "old"),
        });
        const sessionKey = "agent:main:proof";
        const sessionEntry: SessionEntry = {
          sessionId: "proof-session",
          updatedAt: 1,
          authProfileOverride: pinnedProfileId,
          authProfileOverrideSource: "user",
        };
        const sessionStore = { [sessionKey]: sessionEntry };

        await expect(runLogin()).resolves.toMatchObject({
          profiles: [{ profileId: pinnedProfileId, provider: providerId, mode: "oauth" }],
        });
        expect(persistedProfiles(state)).toEqual({
          "other:retained": retainedProfile,
          [pinnedProfileId]: oauthCredential("account-a", "rotated"),
        });
        const selection = await resolveSessionAuthSelection({
          cfg: config,
          provider: providerId,
          modelId: "proof-model",
          agentDir: state.agentDir(),
          sessionEntry,
          sessionStore,
          sessionKey,
          isNewSession: false,
        });
        expect(selection).toMatchObject({ profileId: pinnedProfileId, source: "user" });
        if (!selection) {
          throw new Error("Expected the existing session to retain its selected auth profile");
        }
        await expect(
          resolveApiKeyForProviderCore({
            provider: providerId,
            cfg: config,
            profileId: selection.profileId,
            agentDir: state.agentDir(),
            lockedProfile: true,
          }),
        ).resolves.toMatchObject({
          apiKey: "rotated-access",
          mode: "oauth",
          profileId: pinnedProfileId,
        });
      },
    );
  });

  it("keeps a different account under its provider-generated profile id", async () => {
    await withProofFixture({ accountId: "account-b" }, async ({ state, runLogin }) => {
      seedProfiles(state, { [pinnedProfileId]: oauthCredential("account-a", "old") });

      await expect(runLogin()).resolves.toMatchObject({
        profiles: [{ profileId: generatedProfileId, provider: providerId, mode: "oauth" }],
      });
      expect(persistedProfiles(state)).toEqual({
        [pinnedProfileId]: oauthCredential("account-a", "old"),
        [generatedProfileId]: oauthCredential("account-b", "new"),
      });
    });
  });

  it("rejects a reassigned profile at the transactional write boundary", async () => {
    await withProofFixture({ accountId: "account-a" }, async ({ state, runLogin }) => {
      seedProfiles(state, { [pinnedProfileId]: oauthCredential("account-a", "old") });

      await expect(
        runLogin({
          beforePersistentEffect: () => {
            seedProfiles(state, {
              [pinnedProfileId]: oauthCredential("account-b", "reassigned"),
            });
          },
        }),
      ).rejects.toThrow("existing auth profile identity changed during sign-in");
      expect(persistedProfiles(state)).toEqual({
        [pinnedProfileId]: oauthCredential("account-b", "reassigned"),
      });
    });
  });

  it("recreates a same-account profile id after an intentional forced purge", async () => {
    await withProofFixture(
      { accountId: "account-a", generation: "forced" },
      async ({ state, runLogin }) => {
        seedProfiles(state, {
          "other:retained": retainedProfile,
          [pinnedProfileId]: oauthCredential("account-a", "old"),
        });

        await expect(runLogin({ force: true })).resolves.toMatchObject({
          profiles: [{ profileId: pinnedProfileId, provider: providerId, mode: "oauth" }],
        });
        expect(persistedProfiles(state)).toEqual({
          "other:retained": retainedProfile,
          [pinnedProfileId]: oauthCredential("account-a", "forced"),
        });
      },
    );
  });

  it("rejects another account reclaiming a force-purged id before persistence", async () => {
    await withProofFixture(
      { accountId: "account-a", generation: "forced" },
      async ({ state, runLogin }) => {
        seedProfiles(state, { [pinnedProfileId]: oauthCredential("account-a", "old") });
        let persistentBoundary = 0;

        await expect(
          runLogin({
            force: true,
            beforePersistentEffect: () => {
              persistentBoundary += 1;
              if (persistentBoundary === 2) {
                seedProfiles(state, {
                  [pinnedProfileId]: oauthCredential("account-b", "reassigned"),
                });
              }
            },
          }),
        ).rejects.toThrow("existing auth profile identity changed during sign-in");
        expect(persistentBoundary).toBe(2);
        expect(persistedProfiles(state)).toEqual({
          [pinnedProfileId]: oauthCredential("account-b", "reassigned"),
        });
      },
    );
  });
});
