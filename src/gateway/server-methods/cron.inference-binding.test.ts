import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  removeAuthProfilesAcrossOwnerStores,
  setAuthProfileOrder,
} from "../../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "../../agents/auth-profiles/store-state-owner.test-support.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { prepareAgentRuntimeAuth } from "../../agents/runtime-plan/prepare-auth.js";
import { resolvePreparedRuntimeModelAuth } from "../../agents/runtime-plan/resolve-auth.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronInferenceBinding } from "../../cron/inference-binding.js";
import { acquireCronInferenceAuthorization } from "../../cron/inference-binding.runtime.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronJobsStore } from "../../cron/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { connectUserModelAccountAsync } from "../../state/user-model-account-operations.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import { createCronCallerClient } from "./cron.validation.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";
const sessionKey = "agent:main:binding-creator";

async function withFixture(
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
      requestHeartbeat: () => {},
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
  const setCreator = async (profileId: string, provider = "openai") => {
    await upsertSessionEntryCore(
      { sessionKey, agentId: "main" },
      {
        sessionId: "synthetic-creator-session",
        updatedAt: 1,
        modelProvider: provider,
        model: "gpt-4.1",
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
      cfg = {
        agents: {
          entries: { main: { agentDir } },
          defaults: { model: provider === "openai" ? "openai/gpt-4.1" : "ollama/llama3.3" },
        },
        ...(provider === "ollama"
          ? {
              models: {
                providers: {
                  ollama: {
                    api: "ollama",
                    apiKey: "ollama-local",
                    baseUrl: "http://127.0.0.1:11434",
                    models: [],
                  },
                },
              },
            }
          : configuredKey
            ? {
                models: {
                  providers: {
                    openai: {
                      apiKey: configuredKey,
                      baseUrl: "https://api.openai.com/v1",
                      models: [],
                    },
                  },
                },
              }
            : {}),
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
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: ["operator.admin", "operator.write"],
        },
        authenticatedUserProfile: {
          profileId,
          displayName: "Synthetic Person",
          hasAvatar: false,
          updatedAt: 1,
        },
      });
      return { profileId: authProfileId, owner: person(owner.id), other: person(other.id) };
    },
    addAgent(agentId: string) {
      cfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          entries: {
            ...cfg.agents?.entries,
            [agentId]: { agentDir: path.join(stateDir, "agents", agentId, "agent") },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
    },
    setAlias() {
      cfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            models: { "openai/gpt-4o": { alias: "synthetic-alias" } },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
    },
    setDefaultProfile(profileId: string) {
      cfg = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { model: "openai/gpt-4.1@" + profileId } },
      };
      setRuntimeConfigSnapshot(cfg);
    },
    async changeDefaults(profileId: string) {
      cfg = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { model: "openai/gpt-4o@" + profileId } },
        auth: { ...cfg.auth, order: { openai: [profileId] } },
      };
      setRuntimeConfigSnapshot(cfg);
      await setAuthProfileOrder({ agentDir, provider: "openai", order: [profileId] });
    },
  };
}

function createParams() {
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

describe("cron handler inference binding persistence", () => {
  it.each(["environment", "configuration"] as const)(
    "creates an unbound job on a %s key, the same rule its runs follow",
    async (source) => {
      await withFixture(async (fixture) => {
        const key = "synthetic-direct-key";
        await fixture.useUnstoredCredential("openai", source === "configuration" ? key : undefined);
        await withEnvAsync(
          { OPENAI_API_KEY: source === "environment" ? key : undefined },
          async () => {
            await fixture.invoke("cron.add", createParams());
            expect((await fixture.reload()).inferenceBinding).toBeUndefined();
          },
        );
      });
    },
  );

  it("allows configured credentialless local inference without inventing an account binding", async () => {
    await withFixture(async (fixture) => {
      await fixture.useUnstoredCredential("ollama");
      await fixture.invoke("cron.add", createParams());
      expect((await fixture.reload()).inferenceBinding).toBeUndefined();
    });
  });

  it.each(["add", "update"] as const)(
    "rejects credential replacement after capture before %s commit",
    async (method) => {
      await withFixture(async (fixture) => {
        if (method === "update") {
          await fixture.invoke("cron.add", createParams());
        }
        const original = method === "update" ? await fixture.reload() : undefined;
        const mutation = fixture.replaceAccountBeforeMutation(method);
        try {
          await expect(
            method === "add"
              ? fixture.invoke("cron.add", createParams())
              : fixture.invoke("cron.update", {
                  id: original?.id,
                  patch: { payload: { kind: "agentTurn", model: "openai/gpt-4.1@" + platformId } },
                }),
          ).rejects.toThrow(/MCP authorization/);
          if (original) {
            expect((await fixture.reload()).inferenceBinding).toEqual(original.inferenceBinding);
          } else {
            expect(await fixture.status()).toMatchObject({ jobs: 0 });
          }
        } finally {
          mutation.mockRestore();
        }
      });
    },
  );

  it("requires the personal owner for explicit creation and account adoption", async () => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      const params = {
        ...createParams(),
        payload: {
          ...createParams().payload,
          model: "openai/gpt-4.1@" + personal.profileId,
        },
      };
      const agent = createCronCallerClient("main", undefined, sessionKey);
      for (const caller of [null, agent, personal.other]) {
        await fixture.invoke("cron.add", params, caller, { expectedSuccess: false });
      }
      expect(await fixture.status()).toMatchObject({ jobs: 0 });
      await fixture.invoke("cron.add", createParams(), personal.owner);
      const created = await fixture.reload();
      const originalBinding = created.inferenceBinding;
      const patch = { id: created.id, patch: { payload: params.payload } };
      for (const caller of [agent, personal.other]) {
        await fixture.invoke("cron.update", patch, caller, { expectedSuccess: false });
      }
      expect((await fixture.reload()).inferenceBinding).toEqual(originalBinding);
      await expect(
        fixture.invoke("cron.update", patch, personal.owner, {
          beforeCommit: () => {
            personal.owner.invalidated = true;
          },
        }),
      ).rejects.toThrow("current authorized connection");
      expect((await fixture.reload()).inferenceBinding).toEqual(originalBinding);
      personal.owner.invalidated = false;
      await fixture.invoke("cron.update", patch, personal.owner);
      expect((await fixture.reload()).inferenceBinding).toMatchObject({
        profileId: personal.profileId,
        source: "user",
        authRequirement: "api-key",
      });
    });
  });

  it("inherits a trusted creator's personal selection without turning it into a new user pin", async () => {
    await withFixture(async (fixture) => {
      const personal = await fixture.personalAccount();
      await fixture.setCreator(personal.profileId);
      await fixture.invoke(
        "cron.add",
        createParams(),
        createCronCallerClient("main", undefined, sessionKey),
      );
      expect((await fixture.reload()).inferenceBinding).toMatchObject({
        profileId: personal.profileId,
        source: "auto",
        authRequirement: "api-key",
      });
    });
  });

  it("rejects an agent move that changes credential ownership unless an account is adopted", async () => {
    await withFixture(async (fixture) => {
      await fixture.invoke("cron.add", createParams());
      const created = await fixture.reload();
      fixture.addAgent("secondary");
      await fixture.invoke("cron.update", { id: created.id, patch: { agentId: "main" } });
      expect((await fixture.reload()).inferenceBinding).toEqual(created.inferenceBinding);
      await fixture.invoke(
        "cron.update",
        { id: created.id, patch: { agentId: "secondary" } },
        null,
        { expectedSuccess: false },
      );
      const unchanged = await fixture.reload();
      expect(unchanged.agentId).toBe("main");
      expect(unchanged.inferenceBinding).toEqual(created.inferenceBinding);
      await fixture.invoke("cron.update", {
        id: created.id,
        patch: {
          agentId: "secondary",
          payload: { kind: "agentTurn", model: "openai/gpt-4.1@" + platformId },
        },
      });
      const moved = await fixture.reload();
      expect(moved.agentId).toBe("secondary");
      expect(moved.inferenceBinding).toMatchObject({ profileId: platformId, source: "user" });
      expect(moved.inferenceBinding?.authorizationId).not.toBe(
        created.inferenceBinding?.authorizationId,
      );
    });
  });

  it("adopts an explicit account on an aliased model but not on a plain alias", async () => {
    await withFixture(async (fixture) => {
      fixture.setAlias();
      await fixture.invoke("cron.add", createParams());
      const created = await fixture.reload();
      await fixture.invoke("cron.update", {
        id: created.id,
        patch: {
          payload: { kind: "agentTurn", model: "synthetic-alias@" + subscriptionId },
        },
      });
      const adopted = await fixture.reload();
      expect(adopted.inferenceBinding).toMatchObject({ profileId: subscriptionId, source: "user" });
      await fixture.invoke("cron.update", {
        id: created.id,
        patch: {
          payload: { kind: "agentTurn", model: "synthetic-alias" },
        },
      });
      expect((await fixture.reload()).inferenceBinding).toEqual(adopted.inferenceBinding);
    });
  });
  it.each([
    { profileId: platformId, other: subscriptionId, requirement: "api-key" },
    { profileId: subscriptionId, other: platformId, requirement: "subscription" },
  ])(
    "keeps the creator's $requirement binding until an explicit model@profile update",
    async ({ profileId, other, requirement }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(profileId);
        const client = createCronCallerClient("main", undefined, sessionKey);
        await fixture.invoke("cron.add", createParams(), client);
        const created = await fixture.reload();
        expect(created.inferenceBinding).toEqual({
          version: 1,
          provider: "openai",
          profileId,
          authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          authRequirement: requirement,
          source: "auto",
        });
        const originalBinding = created.inferenceBinding;
        await fixture.changeDefaults(other);
        await fixture.setCreator(other);
        await fixture.invoke(
          "cron.update",
          {
            id: created.id,
            patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o" } },
          },
          client,
        );
        const preserved = await fixture.reload();
        expect(preserved.payload).toMatchObject({ model: "openai/gpt-4o" });
        expect(preserved.inferenceBinding).toEqual(originalBinding);
        await fixture.invoke("cron.get", { id: created.id });
        await fixture.invoke("cron.list", {
          includeDisabled: true,
          includeDeliveryPreviews: false,
        });

        await fixture.invoke(
          "cron.update",
          {
            id: created.id,
            patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o@" + other } },
          },
          client,
        );
        const adopted = await fixture.reload();
        expect(adopted.inferenceBinding).toEqual({
          version: 1,
          provider: "openai",
          profileId: other,
          authorizationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          authRequirement: requirement === "api-key" ? "subscription" : "api-key",
          source: "user",
        });
        expect(adopted.inferenceBinding?.authorizationId).not.toBe(
          originalBinding?.authorizationId,
        );
      });
    },
  );

  it.each([
    { profileId: platformId, creator: subscriptionId, requirement: "api-key" },
    { profileId: subscriptionId, creator: platformId, requirement: "subscription" },
  ])(
    "captures an explicit default $requirement profile before the creator auto selection",
    async ({ profileId, creator, requirement }) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(creator);
        fixture.setDefaultProfile(profileId);
        await fixture.invoke(
          "cron.add",
          createParams(),
          createCronCallerClient("main", undefined, sessionKey),
        );
        const created = await fixture.reload();
        expect(created.inferenceBinding).toMatchObject({
          provider: "openai",
          profileId,
          authRequirement: requirement,
          source: "user",
        });
      });
    },
  );

  it("captures the effective job default instead of an unrelated creator provider", async () => {
    await withFixture(async (fixture) => {
      await fixture.setCreator("anthropic:temporary", "anthropic");
      await fixture.invoke(
        "cron.add",
        createParams(),
        createCronCallerClient("main", undefined, sessionKey),
      );
      const created = await fixture.reload();
      expect(created.payload).not.toHaveProperty("model");
      expect(created.inferenceBinding).toMatchObject({
        provider: "openai",
        profileId: platformId,
        authRequirement: "api-key",
        source: "auto",
      });
    });
  });

  it("replaces a host binding when a native creator adopts the job", async () => {
    await withFixture(async (fixture) => {
      await fixture.setCreator(platformId);
      const client = createCronCallerClient("main", undefined, sessionKey);
      await fixture.invoke("cron.add", createParams(), client);
      const created = await fixture.reload();
      expect(created.inferenceBinding).toMatchObject({ profileId: platformId });
      const authority: CronRuntimeAuthority = {
        version: 1,
        runtimeId: "synthetic-native",
        namespace: "synthetic.inference",
        payload: { account: "synthetic-native-account" },
      };
      const identity = client.internal!.agentRuntimeIdentity!;
      const scope = createCronCreatorAuthorityRunScope(identity.operationalRunInstance.runId);
      identity.cronToolsAllowCapture = "final-executable-surface";
      identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(
        scope,
        undefined,
        authority,
      );
      try {
        await fixture.invoke(
          "cron.update",
          {
            id: created.id,
            patch: {
              payload: {
                kind: "agentTurn",
                message: "Adopt with native inference",
                model: "openai/gpt-4o@openai:missing-native-only",
                toolsAllow: [],
              },
            },
          },
          client,
        );
        const adopted = await fixture.reload();
        expect(adopted.runtimeAuthority).toEqual(authority);
        expect(adopted.inferenceBinding).toBeUndefined();
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
      }
    });
  });

  it.each([true, false])(
    "uses captured runtime authority or binds the creator when capture is empty (payload: %s)",
    async (hasPayload) => {
      await withFixture(async (fixture) => {
        await fixture.setCreator(platformId);
        const authority: CronRuntimeAuthority | undefined = hasPayload
          ? {
              version: 1,
              runtimeId: "synthetic-native",
              namespace: "synthetic.inference",
              payload: { account: "synthetic-native-account" },
            }
          : undefined;
        const client = createCronCallerClient("main", undefined, sessionKey);
        const identity = client.internal!.agentRuntimeIdentity!;
        const scope = createCronCreatorAuthorityRunScope(identity.operationalRunInstance.runId);
        identity.cronToolsAllowCapture = "final-executable-surface";
        identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(
          scope,
          undefined,
          authority,
        );
        try {
          await fixture.invoke("cron.add", createParams(), client);
          const created = await fixture.reload();
          expect(created.runtimeAuthority).toEqual(authority);
          if (hasPayload) {
            expect(created.inferenceBinding).toBeUndefined();
            // Existing native ownership must also win over later explicit host-account edits.
            await fixture.invoke("cron.update", {
              id: created.id,
              patch: { payload: { kind: "agentTurn", model: "openai/gpt-4o@" + subscriptionId } },
            });
            const updated = await fixture.reload();
            expect(updated.runtimeAuthority).toEqual(authority);
            expect(updated.inferenceBinding).toBeUndefined();
          } else {
            expect(created.inferenceBinding).toMatchObject({
              profileId: platformId,
              authRequirement: "api-key",
              source: "auto",
            });
            await fixture.changeDefaults(subscriptionId);
            expect(await fixture.resolveAuth(created.inferenceBinding!)).toMatchObject({
              profileId: platformId,
              mode: "api-key",
              apiKey: "synthetic-platform-key",
            });
          }
        } finally {
          revokeCronCreatorAuthorityRunScope(scope);
        }
      });
    },
  );
});
