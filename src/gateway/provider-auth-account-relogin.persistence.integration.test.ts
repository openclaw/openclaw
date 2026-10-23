import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import {
  runModelsAuthLoginFlowCore,
  type ModelsAuthLoginFlowOptions,
} from "../commands/models/auth.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cleanupPluginLoaderFixturesForTest } from "../plugins/loader.test-fixtures.js";
import { updatePluginManifest, writeWorkspacePlugin } from "../plugins/loader.test-harness.js";
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
type Profiles = Record<string, AuthProfileCredential>;

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

function writeIdentityProvider(workspaceDir: string, credential: AuthProfileCredential) {
  const { plugin } = writeWorkspacePlugin({
    workspaceDir,
    id: providerId,
    body: `module.exports = {
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
                profileId: ${JSON.stringify(generatedProfileId)},
                credential: ${JSON.stringify(credential)},
              }] };
            },
          }],
        });
      },
    };`,
  });
  updatePluginManifest(plugin, { providers: [providerId] });
}

afterAll(cleanupPluginLoaderFixturesForTest);
let cleanupState: OpenClawTestState | undefined;
afterEach(async () => {
  getPluginLoaderCacheState().clear();
  resetPluginRuntimeStateForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  clearAuthProfileMigrationDiagnostics();
  await cleanupState?.cleanup();
  cleanupState = undefined;
});

async function proofFixture(accountId: string, generation = "new", extraProfiles: Profiles = {}) {
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
  cleanupState = state;
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { allow: [providerId], entries: { [providerId]: { enabled: true } } },
  };
  getPluginLoaderCacheState().clear();
  resetPluginRuntimeStateForTest();
  writeIdentityProvider(state.workspaceDir, oauthCredential(accountId, generation));
  await state.writeConfig(config);
  seedProfiles(state, { ...extraProfiles, [pinnedProfileId]: oauthCredential("account-a", "old") });
  const runLogin = (
    options: Pick<ModelsAuthLoginFlowOptions, "force" | "beforePersistentEffect"> = {},
  ) =>
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
  return { state, config, runLogin };
}

function seedProfiles(state: OpenClawTestState, profiles: Profiles): void {
  saveAuthProfileStore({ version: 1, profiles }, state.agentDir(), {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
  clearRuntimeAuthProfileStoreSnapshots();
}

function persistedProfiles(state: OpenClawTestState): Profiles {
  return loadPersistedAuthProfileStore(state.agentDir())?.profiles ?? {};
}

it.each([false, true])("retains pinned account and session (force: %s)", async (force) => {
  const { state, config, runLogin } = await proofFixture("account-a", "rotated", {
    "other:retained": retainedProfile,
  });
  const sessionKey = "agent:main:proof";
  const sessionEntry: SessionEntry = {
    sessionId: "proof-session",
    updatedAt: 1,
    authProfileOverride: pinnedProfileId,
    authProfileOverrideSource: "user",
  };
  await expect(runLogin({ force })).resolves.toMatchObject({
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
    agentId: "main",
    agentDir: state.agentDir(),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    isNewSession: false,
  });
  expect(selection).toMatchObject({ profileId: pinnedProfileId, source: "user" });
  assert(selection, "Expected the existing session to retain its selected auth profile");
  await expect(
    resolveApiKeyForProviderCore({
      provider: providerId,
      cfg: config,
      profileId: selection.profileId,
      agentDir: state.agentDir(),
      lockedProfile: true,
    }),
  ).resolves.toMatchObject({ apiKey: "rotated-access", mode: "oauth", profileId: pinnedProfileId });
});

it("keeps a different account under its provider-generated profile id", async () => {
  const { state, runLogin } = await proofFixture("account-b");
  await expect(runLogin()).resolves.toMatchObject({
    profiles: [{ profileId: generatedProfileId, provider: providerId, mode: "oauth" }],
  });
  expect(persistedProfiles(state)).toEqual({
    [pinnedProfileId]: oauthCredential("account-a", "old"),
    [generatedProfileId]: oauthCredential("account-b", "new"),
  });
});

it.each([false, true])("rejects a reassigned id at persistence (force: %s)", async (force) => {
  const { state, runLogin } = await proofFixture("account-a");
  let persistentBoundary = 0;
  const reassigned = { [pinnedProfileId]: oauthCredential("account-b", "reassigned") };
  await expect(
    runLogin({
      force,
      beforePersistentEffect: () => {
        if (++persistentBoundary === (force ? 2 : 1)) {
          seedProfiles(state, reassigned);
        }
      },
    }),
  ).rejects.toThrow("existing auth profile identity changed during sign-in");
  expect(persistentBoundary).toBe(force ? 2 : 1);
  expect(persistedProfiles(state)).toEqual(reassigned);
});
