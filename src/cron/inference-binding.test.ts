import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../agents/auth-profiles/oauth-native-provider.test-support.js";
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "../agents/auth-profiles/store-state-owner.test-support.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolvePreparedRuntimeModelAuth } from "../agents/runtime-plan/resolve-auth.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "./inference-binding.runtime.js";
import { toPublicCronJob } from "./public-job.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
afterEach(() => vi.restoreAllMocks());
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";

function oauth(access = "synthetic-subscription-access"): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access,
    refresh: "synthetic-subscription-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-account",
  };
}

function config(agentDir: string): OpenClawConfig {
  return {
    agents: { entries: { main: { agentDir } }, defaults: { model: "openai/gpt-4.1" } },
    auth: {
      profiles: {
        [platformId]: { provider: "openai", mode: "api_key" },
        [subscriptionId]: { provider: "openai", mode: "oauth" },
      },
      order: { openai: [platformId, subscriptionId] },
    },
  };
}

async function fixture(
  run: (root: Awaited<ReturnType<typeof seedRoot>>, cfg: OpenClawConfig) => Promise<void>,
  expired = false,
) {
  const seeded = await seedRoot("synthetic-unrelated-root-key");
  // Use the configured main owner, not the seed helper’s unrelated custom agent database.
  const root = { ...seeded, agentDir: path.join(seeded.stateDir, "agents", "main", "agent") };
  await withEnvAsync(
    {
      ...root.env,
      OPENCLAW_CONFIG_PATH: path.join(root.stateDir, "absent-config.json"),
      OPENAI_API_KEY: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
    },
    async () => {
      await persistAuthProfileBatch({
        profiles: [
          { profileId: platformId, credential: apiKey("synthetic-platform-key") },
          {
            profileId: subscriptionId,
            credential: { ...oauth(), ...(expired ? { expires: Date.now() - 1_000 } : {}) },
          },
        ],
      });
      await run(root, config(root.agentDir));
    },
  );
}

function creator(profileId: string): SessionEntry {
  return {
    sessionId: "creator-session",
    updatedAt: 1,
    modelProvider: "openai",
    model: "gpt-4.1",
    authProfileOverride: profileId,
    authProfileOverrideSource: "auto",
  };
}

async function capture(cfg: OpenClawConfig, profileId: string) {
  const sessionEntry = creator(profileId);
  const binding = await captureCronInferenceBinding({ cfg, agentId: "main", sessionEntry });
  if (!binding) {
    throw new Error("Expected creator's stored inference account");
  }
  // Capturing authorization must not pin or otherwise rewrite the creator's session.
  expect(sessionEntry).toEqual(creator(profileId));
  expect(binding).toMatchObject({ version: 1, provider: "openai", profileId, source: "auto" });
  expect(binding.authorizationId).toMatch(/^[a-f0-9]{64}$/);
  return binding;
}

async function persistJob(stateDir: string, binding: CronInferenceBinding) {
  const storePath = path.join(stateDir, "cron", "jobs.json");
  const job = { ...makeCronJob({}), inferenceBinding: binding };
  await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
  expect(JSON.stringify(job.inferenceBinding)).not.toMatch(/synthetic-.*(?:key|access|refresh)/);
  expect(toPublicCronJob(job)).not.toHaveProperty("inferenceBinding");
  // This API's path is a SQLite partition key, not a JSON persistence path.
  await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  return storePath;
}

async function reloadJob(storePath: string) {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  const job = (await loadCronJobsStore(storePath)).jobs[0];
  if (!job?.inferenceBinding) {
    throw new Error("Stored cron inference binding was lost");
  }
  return job;
}

/** Real scheduler/auth owners, stopping at the provider I/O boundary (no session or runner mocks). */
async function resolveFreshRun(
  storePath: string,
  cfg: OpenClawConfig,
  agentDir: string,
  modelId: "gpt-4.1" | "gpt-4o" = "gpt-4o",
) {
  const job = await reloadJob(storePath);
  const binding = job.inferenceBinding!;
  const authority = await acquireCronInferenceAuthorization({ binding, cfg, agentDir });
  try {
    const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
    const prepared = prepareAgentRuntimeAuth({
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      provider: binding.provider,
      modelId,
      modelApi:
        binding.authRequirement === "subscription"
          ? "openai-chatgpt-responses"
          : "openai-responses",
      modelBaseUrl:
        binding.authRequirement === "subscription"
          ? "https://chatgpt.com/backend-api/codex"
          : "https://api.openai.com/v1",
      config: cfg,
      agentId: "main",
      agentDir,
      env: {},
      authProfileStore: store,
      requiredAuthProfileId: binding.profileId,
      sessionAuthProfileId: binding.profileId,
      sessionAuthProfileSource: binding.source,
      allowAuthProfileFallback: false,
      routeIntent: { authRequirement: binding.authRequirement, source: "explicit" },
    });
    const route = prepared.plan.modelRoute;
    if (!route) {
      throw new Error("Expected a concrete provider route");
    }
    const model = makeProviderModelFixture({
      id: modelId,
      name: modelId,
      provider: route.provider,
      api: route.api,
      baseUrl: route.baseUrl,
      contextWindow: 128_000,
      maxTokens: 8_000,
    });
    const resolved = await resolvePreparedRuntimeModelAuth({
      plan: prepared.plan,
      model,
      cfg,
      store,
      agentDir,
    });
    await authority.revalidate();
    authority.assertCurrent();
    return {
      profileId: resolved.auth.profileId,
      mode: resolved.auth.mode,
      apiKey: resolved.auth.apiKey,
      source: resolved.plan.forwardedAuthProfileSource,
      authorizationId: authority.authorizationId,
    };
  } finally {
    authority.dispose();
  }
}

// Account continuity, replacement and revocation use the real HTTP boundary in
// isolated-agent.auth-continuity.integration.test.ts; retain refresh and explicit adoption here.
describe("durable cron inference authorization", () => {
  it("keeps a saved subscription authorized after the real refresh owner settles the same account", async () => {
    await fixture(async (root, cfg) => {
      const binding = await capture(cfg, subscriptionId);
      const storePath = await persistJob(root.stateDir, binding);
      // Expired access is refreshable, not revoked: reacquisition must reach the refresh owner.
      const expired = await acquireCronInferenceAuthorization({
        binding,
        cfg,
        agentDir: root.agentDir,
      });
      expect(expired.authorizationId).toBe(binding.authorizationId);
      expired.dispose();
      const refreshCredential = vi.fn(async () => ({
        access: "synthetic-refreshed-access",
        refresh: "synthetic-refreshed-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "synthetic-account",
      }));
      mockOAuthProviderOperations({ refreshCredential });
      const manager = createOAuthManager();
      const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(root.agentDir);
      const credential = store.profiles[subscriptionId];
      if (credential?.type !== "oauth") {
        throw new Error("Expected persisted OAuth fixture");
      }
      await manager.resolveOAuthAccess({
        store,
        profileId: subscriptionId,
        credential,
        agentDir: root.agentDir,
        forceRefresh: true,
      });
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(await resolveFreshRun(storePath, cfg, root.agentDir, "gpt-4.1")).toMatchObject({
        profileId: subscriptionId,
        mode: "oauth",
        apiKey: "synthetic-refreshed-access",
        authorizationId: binding.authorizationId,
      });
    }, true);
  });

  it("adopts an explicitly selected model@profile only by capturing a new authorized binding", async () => {
    await fixture(async (root, cfg) => {
      const old = await capture(cfg, platformId);
      await upsertAuthProfileWithLockOrThrow({
        profileId: platformId,
        credential: apiKey("synthetic-replacement-key"),
      });
      const adopted = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "openai/gpt-4o@openai:platform",
        sessionEntry: creator(subscriptionId),
      });
      if (!adopted) {
        throw new Error("Explicit adoption must capture the selected owner");
      }
      expect(adopted).toMatchObject({
        profileId: platformId,
        source: "user",
        authRequirement: "api-key",
      });
      expect(adopted.authorizationId).not.toBe(old.authorizationId);
      const storePath = await persistJob(root.stateDir, adopted);
      expect(await resolveFreshRun(storePath, cfg, root.agentDir)).toMatchObject({
        profileId: platformId,
        mode: "api-key",
        apiKey: "synthetic-replacement-key",
        source: "user",
        authorizationId: adopted.authorizationId,
      });
    });
  });

  it("rejects a route incompatible with the stored account instead of substituting Platform billing", async () => {
    await fixture(async (root, cfg) => {
      const binding = await capture(cfg, subscriptionId);
      const storePath = await persistJob(root.stateDir, binding);
      const incompatible: OpenClawConfig = {
        ...cfg,
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      };
      await expect(resolveFreshRun(storePath, incompatible, root.agentDir)).rejects.toThrow(
        /route|subscription|compatible/i,
      );
    });
  });
});
