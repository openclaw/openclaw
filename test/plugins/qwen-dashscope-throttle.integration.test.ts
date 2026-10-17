import { createServer } from "node:http";
import path from "node:path";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it } from "vitest";
import { readPersistedAuthProfileStateRaw } from "../../src/agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../src/agents/auth-profiles/store-runtime.js";
import type { AuthProfileState } from "../../src/agents/auth-profiles/types.js";
import { isProfileInCooldown } from "../../src/agents/auth-profiles/usage-state.js";
import { handleEmbeddedAssistantFailure } from "../../src/agents/embedded-agent-runner/run/assistant-failure.js";
import { createEmbeddedRunFailoverRetryController } from "../../src/agents/embedded-agent-runner/run/failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../src/agents/embedded-agent-runner/run/terminal-outcome.js";
import { makeEmbeddedRunnerAttempt } from "../../src/agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { createPluginMetadataSnapshot } from "../../src/config/plugin-auto-enable.test-helpers.js";
import { withPluginMetadataSnapshotScope } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { loadPluginManifestRegistryCore } from "../../src/plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { resolveProviderRuntimePluginHandle } from "../../src/plugins/provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../src/plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../src/test-utils/plugin-registration.js";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../helpers/gateway-integration-fixtures.js";

const MODEL_ID = "qwen3.8-max";
const QWEN_TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan";

const model = makeProviderModelFixture<"openai-completions">({
  id: MODEL_ID,
  name: "Qwen fixture",
  api: "openai-completions",
  provider: QWEN_TOKEN_PLAN_PROVIDER_ID,
  baseUrl: "",
  contextWindow: 32_000,
  maxTokens: 2_048,
});

const registeredProviders = new Map<string, ProviderPlugin[]>();
let availabilitySnapshot: ReturnType<typeof createPluginMetadataSnapshotFixture>;

beforeAll(async () => {
  const registry = loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: ["qwen", "openrouter"].map((id) => ({
      idHint: id,
      rootDir: path.resolve("extensions", id),
      source: path.resolve("extensions", id, "index.ts"),
      origin: "bundled" as const,
    })),
  });
  availabilitySnapshot = createPluginMetadataSnapshotFixture(registry);
  for (const pluginId of ["qwen", "openrouter"]) {
    const { default: plugin } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
    }>({ pluginId, artifactBasename: "index.js" });
    const { providers } = await registerProviderPlugin({ plugin, id: pluginId, name: pluginId });
    registeredProviders.set(pluginId, providers);
  }
});

type ErrorFixture = {
  status: number;
  code: string | number;
  type?: string;
  message: string;
  metadata?: { raw: string };
};

function prepareProviderOwner(providerId: string, pluginId = "qwen"): ProviderPlugin {
  const provider = requireRegisteredProvider(registeredProviders.get(pluginId) ?? [], providerId);
  const registry = createEmptyPluginRegistry();
  registry.providers.push({ pluginId, provider, source: "test" });
  const config = {};
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  const handle = withPluginRuntimeGenerationScope(
    { metadataSnapshot, pluginRegistry: registry },
    () =>
      resolveProviderRuntimePluginHandle({
        provider: providerId,
        providerOwner: provider.id,
        modelId: MODEL_ID,
        config,
      }),
  );
  if (!handle.plugin) {
    throw new Error(`prepared provider owner missing for ${providerId}`);
  }
  return handle.plugin;
}

async function runTransportError(provider: string, fixture: ErrorFixture) {
  const server = createServer((request, response) => {
    request.resume();
    respondJson(
      response,
      {
        error: {
          code: fixture.code,
          type: fixture.type ?? fixture.code,
          message: fixture.message,
          ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
        },
      },
      fixture.status,
    );
  });
  const baseUrl = `${await listenLoopback(server)}/compatible-mode/v1`;
  try {
    const assistant = await streamOpenAICompletions(
      { ...model, provider, baseUrl },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "synthetic-test-key" },
    ).result();
    expect(assistant).toMatchObject({
      stopReason: "error",
      provider,
      model: MODEL_ID,
      errorCode: String(fixture.code),
    });
    expect(assistant.errorMessage).toContain(fixture.message);
    if (fixture.metadata) {
      expect(assistant.errorMessage).toContain(fixture.metadata.raw);
    }
    return assistant;
  } finally {
    await closeHttpServer(server);
  }
}

async function runThroughFailureRecoveryInScope({
  provider,
  providerOwner,
  fixture,
}: {
  provider: string;
  providerOwner?: ProviderPlugin;
  fixture: ErrorFixture;
}) {
  const assistant = await runTransportError(provider, fixture);
  return await withOpenClawTestState(
    { label: `qwen-dashscope-${provider.replaceAll(/[^a-z0-9]+/gi, "-")}` },
    async (state) => {
      const profileId = `${provider}:fixture`;
      const agentDir = state.agentDir();
      const profileStore = {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key" as const,
            provider,
            key: "synthetic-test-key",
          },
        },
      };
      await state.writeAuthProfiles(profileStore);
      const sessionId = `session:${provider}:${fixture.code}`;
      const runParams = {
        runId: `run:${provider}:${fixture.code}`,
        sessionId,
        sessionKey: `agent:main:${provider}:${fixture.code}`,
        sessionFile: `${agentDir}/session.jsonl`,
        workspaceDir: agentDir,
        prompt: "hello",
        timeoutMs: 60_000,
        config: {},
      } satisfies Parameters<typeof handleEmbeddedAssistantFailure>[0]["runInput"]["runParams"];
      const runInput = { runParams, agentDir, fallbackConfigured: false };
      const runtime = { pluginHarnessOwnsTransport: false, lastProfileId: profileId };
      const preparedRuntime = { provider, modelId: MODEL_ID };
      const failover = createEmbeddedRunFailoverRetryController({
        runInput: {
          ...runInput,
          globalLane: "qwen-dashscope-throttle-test",
        },
        preparedRuntime: {
          ...preparedRuntime,
          profileFailureStore: profileStore,
          snapshot: () => ({
            ...runtime,
            agentHarness: { id: "embedded" },
          }),
          getApiKeyInfo: () => null,
          advanceAttemptAuthProfile: async () => false,
        },
        getSessionId: () => sessionId,
      });
      const attempt = makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        messagesSnapshot: [assistant],
      });
      let failureReason: unknown;
      const suspensionReasons: string[] = [];
      try {
        await handleEmbeddedAssistantFailure({
          runInput: {
            ...runInput,
            suspendForFailure: ({ reason }) => {
              suspensionReasons.push(reason);
            },
            isProbeSession: false,
          },
          normalizedAttempt: {
            attempt,
            attemptAssistant: assistant,
            currentAttemptAssistant: assistant,
            terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
            activeErrorContext: { provider, model: MODEL_ID },
          },
          preparedRuntime: {
            ...preparedRuntime,
            model: { id: MODEL_ID },
            attemptedThinking: new Set(["off"]),
            attemptAuthProfileStore: profileStore,
            maybeRefreshRuntimeAuthForAuthError: async () => false,
          },
          runtime: {
            thinkLevel: "off",
            ...runtime,
          },
          providerOwner,
          getThinkLevel: () => "off",
          runtimeAuthRetry: false,
          failover,
          emptyErrorRetries: 0,
          overloadProfileRotations: 0,
          previousRetryFailoverReason: null,
          traceAttempts: [],
          suspensionSessionId: sessionId,
        });
      } catch (error) {
        failureReason =
          typeof error === "object" && error !== null && "reason" in error
            ? Reflect.get(error, "reason")
            : undefined;
      }
      const persisted = readPersistedAuthProfileStateRaw(agentDir) as AuthProfileState | null;
      const freshStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      expect(freshStore.usageStats?.[profileId]).toEqual(persisted?.usageStats?.[profileId]);
      return {
        failureReason,
        usage: persisted?.usageStats?.[profileId],
        affectedModelBlocked: isProfileInCooldown(freshStore, profileId, undefined, MODEL_ID),
        otherModelBlocked: isProfileInCooldown(freshStore, profileId, undefined, "qwen3.8-flash"),
        suspensionReasons,
      };
    },
  );
}

function runThroughFailureRecovery(params: Parameters<typeof runThroughFailureRecoveryInScope>[0]) {
  return withPluginMetadataSnapshotScope(
    availabilitySnapshot,
    () => runThroughFailureRecoveryInScope(params),
    { trustConfigIdentity: true },
  );
}

function expectFailureState(
  result: Awaited<ReturnType<typeof runThroughFailureRecovery>>,
  reason: "rate_limit" | "billing",
  openRouter: boolean,
): void {
  const billing = reason === "billing";
  const managedThrottle = openRouter && !billing;
  expect.soft(result).toMatchObject({
    failureReason: reason,
    affectedModelBlocked: !managedThrottle,
    otherModelBlocked: billing,
  });
  if (openRouter) {
    expect.soft(result.suspensionReasons).toEqual([billing ? "manual" : "quota_exhausted"]);
  }
  if (managedThrottle) {
    expect.soft(result.usage).toBeUndefined();
    return;
  }
  expect.soft(result.usage).toMatchObject(
    billing
      ? {
          disabledReason: "billing",
          disabledUntil: expect.any(Number),
        }
      : {
          cooldownReason: "rate_limit",
          cooldownModel: MODEL_ID,
          cooldownUntil: expect.any(Number),
        },
  );
  for (const key of billing ? ["cooldownReason"] : ["disabledReason", "disabledUntil"]) {
    expect.soft(result.usage).not.toHaveProperty(key);
  }
}

describe("self-managed provider HTTP recovery", () => {
  const provider = "self-managed-fixture";
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: provider, providers: [provider], managesOwnAvailability: true }],
  });
  it.each([
    { status: 429, message: "Too many requests", reason: "rate_limit", transient: true },
    { status: 503, message: "Provider overloaded", reason: "overloaded", transient: true },
    { status: 401, message: "Invalid API key", reason: "auth", transient: false },
    { status: 402, message: "Insufficient credits", reason: "billing", transient: false },
  ] as const)(
    "enforces policy after HTTP $status",
    async ({ status, message, reason, transient }) => {
      const result = await withPluginMetadataSnapshotScope(
        snapshot,
        () =>
          runThroughFailureRecoveryInScope({
            provider,
            fixture: { status, code: status, message },
          }),
        { trustConfigIdentity: true },
      );
      expect(result).toMatchObject({
        failureReason: reason,
        affectedModelBlocked: !transient,
        otherModelBlocked: !transient,
      });
      if (transient) {
        expect(result.usage).toBeUndefined();
      } else {
        expect(result.usage).toMatchObject(
          reason === "billing"
            ? { disabledReason: reason, disabledUntil: expect.any(Number) }
            : { cooldownReason: reason, cooldownUntil: expect.any(Number) },
        );
      }
    },
  );
});

describe("Qwen DashScope 429 profile classification", () => {
  const quotaCode = "insufficient_quota";
  const allocated = "Allocated quota exceeded, please increase your quota limit.";
  const exceeded = "You exceeded your current quota, please check your plan and billing details.";
  it.each<
    [
      provider: string,
      code: ErrorFixture["code"],
      message: string,
      reason: "rate_limit" | "billing",
      metadata?: ErrorFixture["metadata"],
    ]
  >([
    ["openrouter", 429, "Provider returned error", "rate_limit"],
    [
      "openrouter",
      429,
      "Provider returned error",
      "billing",
      { raw: '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}' },
    ],
    ["openrouter", 429, "API key budget limit exceeded", "billing"],
    [QWEN_TOKEN_PLAN_PROVIDER_ID, quotaCode, allocated, "rate_limit"],
    ["qwen", "Throttling.AllocationQuota", allocated, "rate_limit"],
    ["bailian-token-plan", quotaCode, exceeded, "rate_limit"],
    ["qwen", "PrepaidBillOverdue", "The prepaid bill is overdue.", "billing"],
    ["qwen", "rate_limit_error", "Rate limit exceeded", "rate_limit"],
    ["openai", quotaCode, exceeded, "billing"],
    ["qwen", quotaCode, "Free allocated quota exceeded.", "billing"],
    ["qwen", quotaCode, "Unknown quota condition", "billing"],
  ])("classifies %s %s (%s) as %s", async (provider, code, message, reason, metadata) => {
    const result = await runThroughFailureRecovery({
      provider,
      providerOwner:
        provider === "openai"
          ? undefined
          : prepareProviderOwner(provider, provider === "openrouter" ? "openrouter" : "qwen"),
      fixture: { status: 429, code, message, ...(metadata ? { metadata } : {}) },
    });
    expectFailureState(result, reason, provider === "openrouter");
  });
});
