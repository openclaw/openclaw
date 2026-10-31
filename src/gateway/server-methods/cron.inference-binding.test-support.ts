import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "../../agents/auth-profiles/store-state-owner.test-support.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import { prepareAgentRuntimeAuth } from "../../agents/runtime-plan/prepare-auth.js";
import { resolvePreparedRuntimeModelAuth } from "../../agents/runtime-plan/resolve-auth.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronInferenceBinding } from "../../cron/inference-binding.js";
import { acquireCronInferenceAuthorization } from "../../cron/inference-binding.runtime.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronJobsStore } from "../../cron/store.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { connectUserModelAccountAsync } from "../../state/user-model-account-operations.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
export const platformId = "openai:platform";
export const subscriptionId = "openai:subscription";
export const sessionKey = "agent:main:binding-creator";

export async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const root = await seedRoot("synthetic-unrelated-root-key");
  const agentDir = path.join(root.stateDir, "agents", "main", "agent");
  await withEnvAsync(
    {
      ...root.env,
      OPENCLAW_CONFIG_PATH: path.join(root.stateDir, "absent-config.json"),
      OPENAI_API_KEY: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
      OLLAMA_API_KEY: undefined,
    },
    async () => {
      const fixture = await createFixture(root.stateDir, agentDir);
      try {
        await run(fixture);
      } finally {
        await fixture.stop();
        clearRuntimeConfigSnapshot();
        setCurrentPluginMetadataSnapshot(undefined);
        resetPluginRuntimeStateForTest();
      }
    },
  );
}

async function createFixture(stateDir: string, agentDir: string) {
  let cfg: OpenClawConfig = {
    agents: { entries: { main: { agentDir } }, defaults: { model: "openai/gpt-4.1" } },
    auth: {
      profiles: {
        [platformId]: { provider: "openai", mode: "api_key" },
        [subscriptionId]: { provider: "openai", mode: "oauth" },
      },
      order: { openai: [platformId, subscriptionId] },
    },
  };
  const publish = (patch: Partial<OpenClawConfig>) => {
    cfg = { ...cfg, ...patch };
    setRuntimeConfigSnapshot(cfg);
  };
  const providerConfig = (provider: "openai" | "ollama", key?: string) => ({
    ...(provider === "ollama" ? { api: "ollama" as const } : {}),
    ...(key === undefined ? {} : { apiKey: key }),
    baseUrl: provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1",
    models: [],
  });
  setRuntimeConfigSnapshot(cfg);
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
          expires: Date.now() + 3_600_000,
          accountId: "synthetic-subscription-account",
        },
      },
    ],
  });
  const storePath = path.join(stateDir, "cron", "jobs.json");
  const makeService = () =>
    new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: () => {},
      runIsolatedAgentJob: async () => {
        throw new Error("Persistence proof must not execute an inference request");
      },
    });
  let cron = makeService();
  const stop = async () => {
    cron.stop();
    await cron.waitForIdle();
  };
  const reload = async () => {
    await stop();
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    cron = makeService();
    // The advertised jobs.json path is only a SQLite partition key.
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cron.status()).toMatchObject({ storage: "sqlite", jobs: 1 });
    const [job] = (await loadCronJobsStore(storePath)).jobs;
    if (!job) {
      throw new Error("Expected the committed job after reopening SQLite");
    }
    return job;
  };
  const invoke = async (
    method: "cron.add" | "cron.update" | "cron.get" | "cron.list",
    params: Record<string, unknown>,
    client: GatewayClient | null = null,
    options: { expectedSuccess?: boolean; beforeCommit?: () => void } = {},
  ) => {
    const handler = cronHandlers[method];
    if (!handler) {
      throw new Error("Missing cron handler");
    }
    const respond = vi.fn<RespondFn>();
    await handler({
      req: { type: "req", id: "binding-regression", method, params },
      params,
      respond,
      context: createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        getClientConnIds: (filter) =>
          new Set(
            client?.connId && !client.invalidated && (!filter || filter(client))
              ? [client.connId]
              : [],
          ),
      }),
      client,
      sessionMutationCommitGuard: options.beforeCommit,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledOnce();
    const response = respond.mock.calls[0];
    expect(response?.[0], JSON.stringify(response?.[2])).toBe(options.expectedSuccess ?? true);
    if (options.expectedSuccess === false) {
      return response?.[2];
    }
    const serialized = JSON.stringify(response?.[1]);
    expect(serialized).not.toMatch(/inferenceBinding|authorizationId|runtimeAuthority/);
    expect(serialized).not.toMatch(
      /synthetic-(?:platform-key|subscription-access|subscription-refresh)/,
    );
    return response?.[1];
  };
  const setCreator = async (profileId: string, provider = "openai", modelOverride?: string) => {
    await upsertSessionEntryCore(
      { sessionKey, agentId: "main" },
      {
        sessionId: "synthetic-creator-session",
        updatedAt: 1,
        modelProvider: provider,
        model: "gpt-4.1",
        ...(modelOverride ? { providerOverride: provider, modelOverride } : {}),
        authProfileOverride: profileId,
        authProfileOverrideSource: "auto",
      },
    );
  };
  return {
    invoke,
    reload,
    stop,
    setCreator,
    status: () => cron.status(),
    setWorkerInference(required: boolean, inference: "worker" | "gateway") {
      // Dedicated workers keep the model route on the Gateway, but own its credentials.
      cfg.models = {
        providers: {
          openai: {
            ...providerConfig("openai"),
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
          },
        },
      };
      cfg.cloudWorkers = {
        ...(required ? { requiredProfile: "dedicated-native" } : {}),
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "synthetic-worker", inference },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
    },
    setCodexRuntime({ runtime = "codex", registered = true, supported = true } = {}) {
      const model = "codex/openai-compatible/gpt-5.4";
      cfg.agents!.defaults = {
        model,
        models: { [model]: { agentRuntime: { id: runtime } } },
      };
      cfg.models = {
        providers: {
          codex: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "openai-compatible/gpt-5.4",
                name: "gpt-5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 8192,
              },
            ],
          },
        },
      };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
      });
      metadata.index.plugins[0]!.syntheticAuthRefs = ["codex"];
      setCurrentPluginMetadataSnapshot(metadata, { config: cfg });
      setActivePluginRegistry(createEmptyPluginRegistry());
      if (registered) {
        registerAgentHarness({
          id: "codex",
          label: "Codex fixture",
          authBootstrap: "harness",
          supports: () => ({ supported }),
          runAttempt: async () => {
            throw new Error("Admission proof must not start the Harness");
          },
        });
      }
      setRuntimeConfigSnapshot(cfg);
    },
    replaceAccountBeforeMutation(method: "add" | "update") {
      const replace = () =>
        persistAuthProfileBatch({
          profiles: [{ profileId: platformId, credential: apiKey("synthetic-replacement-key") }],
        });
      if (method === "add") {
        const add = cron.add.bind(cron);
        return vi.spyOn(cron, "add").mockImplementationOnce(async (...args) => {
          await replace();
          return add(...args);
        });
      }
      const update = cron.updateWithPrecondition.bind(cron);
      return vi.spyOn(cron, "updateWithPrecondition").mockImplementationOnce(async (...args) => {
        await replace();
        return update(...args);
      });
    },
    async resolveAuth(binding: CronInferenceBinding) {
      const authority = await acquireCronInferenceAuthorization({ binding, cfg, agentDir });
      try {
        const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
        const prepared = prepareAgentRuntimeAuth({
          provider: binding.provider,
          modelId: "gpt-4.1",
          config: cfg,
          agentId: "main",
          agentDir,
          authProfileStore: store,
          requiredAuthProfileId: binding.profileId,
          sessionAuthProfileId: binding.profileId,
          sessionAuthProfileSource: binding.source,
          allowAuthProfileFallback: false,
          routeIntent: { authRequirement: binding.authRequirement, source: "explicit" },
        });
        const resolved = await resolvePreparedRuntimeModelAuth({
          plan: prepared.plan,
          cfg,
          store,
          agentDir,
          model: {
            id: "gpt-4.1",
            name: "Synthetic scheduled model",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 1_024,
          },
        });
        await authority.revalidate();
        authority.assertCurrent();
        return resolved.auth;
      } finally {
        authority.dispose();
      }
    },
    async useUnstoredCredential(provider: "openai" | "ollama", configuredKey?: string) {
      const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
      await removeAuthProfilesAcrossOwnerStores({ profileIds: Object.keys(store.profiles) });
      const models =
        provider === "ollama" || configuredKey
          ? {
              providers: {
                [provider]: providerConfig(
                  provider,
                  provider === "ollama" ? "ollama-local" : configuredKey,
                ),
              },
            }
          : undefined;
      cfg = {
        agents: {
          entries: { main: { agentDir } },
          defaults: { model: provider === "openai" ? "openai/gpt-4.1" : "ollama/llama3.3" },
        },
        ...(models ? { models } : {}),
      };
      setRuntimeConfigSnapshot(cfg);
    },
    async personalAccount() {
      const owner = ensureProfileForEmail("cron-owner@example.test");
      const other = ensureProfileForEmail("cron-other@example.test");
      const { authProfileId } = await connectUserModelAccountAsync({
        ownerProfileId: owner.id,
        credential: apiKey("synthetic-personal-key"),
        assertCurrent() {},
      });
      const person = (profileId: string): GatewayClient => ({
        connId: "synthetic-cron-person",
        invalidated: false,
        connect: gatewayConnect(["operator.admin", "operator.write"]),
        authenticatedUserProfile: gatewayProfile(profileId, "Synthetic Person"),
      });
      return { profileId: authProfileId, owner: person(owner.id), other: person(other.id) };
    },
    addAgent(agentId: string) {
      publish({
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents?.entries,
            [agentId]: { agentDir: path.join(stateDir, "agents", agentId, "agent") },
          },
        },
      });
    },
    setAlias() {
      publish({
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            models: { "openai/gpt-4o": { alias: "synthetic-alias" } },
          },
        },
      });
    },
    setDefaultProfile(profileId: string) {
      publish({
        agents: { ...cfg.agents, defaults: { model: "openai/gpt-4.1@" + profileId } },
      });
    },
    setScheduledProfile(profileId: string, scope: "agent" | "default", allowed: boolean) {
      const subagents = { model: "openai/gpt-4o@" + profileId };
      cfg.agents!.defaults!.modelPolicy = {
        allow: allowed ? ["openai/gpt-4.1", "openai/gpt-4o"] : ["openai/gpt-4.1"],
      };
      if (scope === "agent") {
        cfg.agents!.entries!.main!.subagents = subagents;
      } else {
        cfg.agents!.defaults!.subagents = subagents;
      }
      setRuntimeConfigSnapshot(cfg);
    },
    setGmailProfile(profileId: string) {
      cfg.hooks = { ...cfg.hooks, gmail: { model: "openai/gpt-4o@" + profileId } };
      cfg.agents!.defaults!.modelPolicy = { allow: ["openai/gpt-4.1", "openai/gpt-4o"] };
      setRuntimeConfigSnapshot(cfg);
    },
    async changeDefaults(profileId: string) {
      publish({
        agents: { ...cfg.agents, defaults: { model: "openai/gpt-4o@" + profileId } },
        auth: { ...cfg.auth, order: { openai: [profileId] } },
      });
      await setAuthProfileOrder({ agentDir, provider: "openai", order: [profileId] });
    },
  };
}

export function createParams() {
  return {
    name: "Durable inference binding",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Synthetic scheduled prompt", toolsAllow: [] },
    delivery: { mode: "none" },
  };
}
