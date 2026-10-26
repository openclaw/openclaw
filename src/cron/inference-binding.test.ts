import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../agents/auth-profiles/oauth-native-provider.test-support.js";
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "../agents/auth-profiles/store-state-owner.test-support.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
            credential: {
              type: "oauth",
              provider: "openai",
              access: "synthetic-subscription-access",
              refresh: "synthetic-subscription-refresh",
              accountId: "synthetic-account",
              expires: Date.now() + (expired ? -1_000 : 3_600_000),
            },
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
  const binding = expectDefined(
    await captureCronInferenceBinding({ cfg, agentId: "main", sessionEntry }),
    "creator's stored inference account",
  );
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
  return expectDefined(
    (await loadCronJobsStore(storePath)).jobs[0]?.inferenceBinding,
    "stored cron inference binding",
  );
}

async function reloadAuthorizedBinding(storePath: string, cfg: OpenClawConfig, agentDir: string) {
  const binding = await reloadJob(storePath);
  const authority = await acquireCronInferenceAuthorization({ binding, cfg, agentDir });
  try {
    await authority.revalidate();
    authority.assertCurrent();
    expect(authority.authorizationId).toBe(binding.authorizationId);
    const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
    return {
      binding,
      credential: store.profiles[binding.profileId],
    };
  } finally {
    authority.dispose();
  }
}

// Account continuity, replacement and revocation use the real HTTP boundary in
// isolated-agent.auth-continuity.integration.test.ts; retain refresh and explicit adoption here.
describe("durable cron inference authorization", () => {
  it.each([platformId, subscriptionId])(
    "allows concurrent runs to reacquire the same saved account (%s)",
    async (profileId) => {
      await fixture(async (root, cfg) => {
        // capture releases its observation, as saving a job does before its runs start.
        const binding = await capture(cfg, profileId);
        const results = await Promise.allSettled(
          [0, 1].map(() =>
            acquireCronInferenceAuthorization({ binding, cfg, agentDir: root.agentDir }),
          ),
        );
        try {
          for (const result of results) {
            if (result.status === "rejected") {
              throw result.reason;
            }
            expect(result.value.authorizationId).toBe(binding.authorizationId);
            await result.value.revalidate();
            expect(result.value.assertCurrent).not.toThrow();
          }
        } finally {
          for (const result of results) {
            if (result.status === "fulfilled") {
              result.value.dispose();
            }
          }
        }
      });
    },
  );

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
      const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(root.agentDir);
      const credential = store.profiles[subscriptionId];
      if (credential?.type !== "oauth") {
        throw new Error("Expected persisted OAuth fixture");
      }
      await createOAuthManager().resolveOAuthAccess({
        store,
        profileId: subscriptionId,
        credential,
        agentDir: root.agentDir,
        forceRefresh: true,
      });
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(await reloadAuthorizedBinding(storePath, cfg, root.agentDir)).toMatchObject({
        binding,
        credential: { type: "oauth", access: "synthetic-refreshed-access" },
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
      const adopted = expectDefined(
        await captureCronInferenceBinding({
          cfg,
          agentId: "main",
          model: "openai/gpt-4o@openai:platform",
          sessionEntry: creator(subscriptionId),
        }),
        "explicitly adopted owner",
      );
      expect(adopted).toMatchObject({
        profileId: platformId,
        source: "user",
        authRequirement: "api-key",
      });
      expect(adopted.authorizationId).not.toBe(old.authorizationId);
      const storePath = await persistJob(root.stateDir, adopted);
      expect(await reloadAuthorizedBinding(storePath, cfg, root.agentDir)).toMatchObject({
        binding: adopted,
        credential: { type: "api_key", key: "synthetic-replacement-key" },
      });
    });
  });
});
