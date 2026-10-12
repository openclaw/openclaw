import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it } from "vitest";
import { readPersistedAuthProfileStateRaw } from "../../src/agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../src/agents/auth-profiles/store-runtime.js";
import { isProfileInCooldown } from "../../src/agents/auth-profiles/usage-state.js";
import { handleEmbeddedAssistantFailure } from "../../src/agents/embedded-agent-runner/run/assistant-failure.js";
import { createEmbeddedRunFailoverRetryController } from "../../src/agents/embedded-agent-runner/run/failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../src/agents/embedded-agent-runner/run/terminal-outcome.js";
import { makeEmbeddedRunnerAttempt } from "../../src/agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createPluginMetadataSnapshot } from "../../src/config/plugin-auto-enable.test-helpers.js";
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

const MODEL_ID = "qwen3.8-max";
const QWEN_TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan";

const model = {
  id: MODEL_ID,
  name: "Qwen fixture",
  api: "openai-completions",
  provider: QWEN_TOKEN_PLAN_PROVIDER_ID,
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 2_048,
} satisfies Model<"openai-completions">;

const registeredProviders = new Map<string, ProviderPlugin[]>();

beforeAll(async () => {
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

type ProfileUsageReadback = {
  cooldownUntil?: number;
  cooldownReason?: string;
  cooldownModel?: string;
  disabledUntil?: number;
  disabledReason?: string;
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

async function runTransportError(params: {
  provider: string;
  fixture: ErrorFixture;
}): Promise<AssistantMessage> {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(params.fixture.status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: params.fixture.code,
          type: params.fixture.type ?? params.fixture.code,
          message: params.fixture.message,
          ...(params.fixture.metadata ? { metadata: params.fixture.metadata } : {}),
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const assistant = await streamOpenAICompletions(
      {
        ...model,
        provider: params.provider,
        baseUrl: `http://127.0.0.1:${address.port}/compatible-mode/v1`,
      },
      context,
      { apiKey: "synthetic-test-key" },
    ).result();
    expect(assistant).toMatchObject({
      stopReason: "error",
      provider: params.provider,
      model: MODEL_ID,
      errorCode: String(params.fixture.code),
    });
    expect(assistant.errorMessage).toContain(params.fixture.message);
    if (params.fixture.metadata) {
      expect(assistant.errorMessage).toContain(params.fixture.metadata.raw);
    }
    return assistant;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function runThroughFailureRecovery(params: {
  provider: string;
  providerOwner?: ProviderPlugin;
  fixture: ErrorFixture;
}): Promise<{
  failureReason: unknown;
  usage: ProfileUsageReadback | undefined;
  affectedModelBlocked: boolean;
  otherModelBlocked: boolean;
  suspensionReasons: string[];
}> {
  const assistant = await runTransportError(params);
  return await withOpenClawTestState(
    { label: `qwen-dashscope-${params.provider.replaceAll(/[^a-z0-9]+/gi, "-")}` },
    async (state) => {
      const profileId = `${params.provider}:fixture`;
      const profileStore = {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key" as const,
            provider: params.provider,
            key: "synthetic-test-key",
          },
        },
      };
      await state.writeAuthProfiles(profileStore);
      const runId = `run:${params.provider}:${params.fixture.code}`;
      const sessionId = `session:${params.provider}:${params.fixture.code}`;
      const runParams = {
        runId,
        sessionId,
        sessionKey: `agent:main:${params.provider}:${params.fixture.code}`,
        sessionFile: `${state.agentDir()}/session.jsonl`,
        workspaceDir: state.agentDir(),
        prompt: "hello",
        timeoutMs: 60_000,
        config: {},
      } satisfies Parameters<typeof handleEmbeddedAssistantFailure>[0]["runInput"]["runParams"];
      const failover = createEmbeddedRunFailoverRetryController({
        runInput: {
          runParams,
          globalLane: "qwen-dashscope-throttle-test",
          agentDir: state.agentDir(),
          fallbackConfigured: false,
        },
        preparedRuntime: {
          provider: params.provider,
          modelId: MODEL_ID,
          profileFailureStore: profileStore,
          snapshot: () => ({
            lastProfileId: profileId,
            pluginHarnessOwnsTransport: false,
            agentHarness: { id: "embedded" },
          }),
          getApiKeyInfo: () => null,
          advanceAttemptAuthProfile: async () => false,
          hasRemainingAuthAttempt: () => false,
        },
        getSessionId: () => sessionId,
      });
      const attempt = makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        messagesSnapshot: [assistant],
      });
      const terminalState = resolveEmbeddedRunAttemptTerminalState({
        attempt,
        assistant,
      });
      let failureReason: unknown;
      const suspensionReasons: string[] = [];
      try {
        await handleEmbeddedAssistantFailure({
          runInput: {
            runParams,
            fallbackConfigured: false,
            suspendForFailure: ({ reason }) => {
              suspensionReasons.push(reason);
            },
            agentDir: state.agentDir(),
            isProbeSession: false,
          },
          normalizedAttempt: {
            attempt,
            attemptAssistant: assistant,
            currentAttemptAssistant: assistant,
            terminalState,
            activeErrorContext: { provider: params.provider, model: MODEL_ID },
          },
          preparedRuntime: {
            provider: params.provider,
            modelId: MODEL_ID,
            model: { id: MODEL_ID },
            attemptedThinking: new Set(["off"]),
            attemptAuthProfileStore: profileStore,
            maybeRefreshRuntimeAuthForAuthError: async () => false,
          },
          runtime: {
            thinkLevel: "off",
            pluginHarnessOwnsTransport: false,
            lastProfileId: profileId,
          },
          providerOwner: params.providerOwner,
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
      const persisted = readPersistedAuthProfileStateRaw(state.agentDir()) as {
        usageStats?: Record<string, ProfileUsageReadback>;
      } | null;
      const freshStore = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir());
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

function expectRateLimitState(result: Awaited<ReturnType<typeof runThroughFailureRecovery>>): void {
  expect.soft(result.failureReason).toBe("rate_limit");
  expect.soft(result.usage).toMatchObject({
    cooldownReason: "rate_limit",
    cooldownModel: MODEL_ID,
    cooldownUntil: expect.any(Number),
  });
  expect.soft(result.usage).not.toHaveProperty("disabledReason");
  expect.soft(result.usage).not.toHaveProperty("disabledUntil");
  expect.soft(result.affectedModelBlocked).toBe(true);
  expect.soft(result.otherModelBlocked).toBe(false);
}

function expectBillingState(result: Awaited<ReturnType<typeof runThroughFailureRecovery>>): void {
  expect.soft(result.failureReason).toBe("billing");
  expect.soft(result.usage).toMatchObject({
    disabledReason: "billing",
    disabledUntil: expect.any(Number),
  });
  expect.soft(result.usage).not.toHaveProperty("cooldownReason");
  expect.soft(result.affectedModelBlocked).toBe(true);
  expect.soft(result.otherModelBlocked).toBe(true);
}

function expectOpenRouterState(
  result: Awaited<ReturnType<typeof runThroughFailureRecovery>>,
  reason: "rate_limit" | "billing",
): void {
  expect.soft(result.failureReason).toBe(reason);
  expect
    .soft(result.suspensionReasons)
    .toEqual([reason === "rate_limit" ? "quota_exhausted" : "manual"]);
  // OpenRouter manages credential cooldowns; preserve the existing writer/reader bypass.
  expect.soft(result.usage).toBeUndefined();
  expect.soft(result.affectedModelBlocked).toBe(false);
  expect.soft(result.otherModelBlocked).toBe(false);
}

describe("Qwen DashScope 429 profile classification", () => {
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
    [
      QWEN_TOKEN_PLAN_PROVIDER_ID,
      "insufficient_quota",
      "Allocated quota exceeded, please increase your quota limit.",
      "rate_limit",
    ],
    [
      "qwen",
      "Throttling.AllocationQuota",
      "Allocated quota exceeded, please increase your quota limit.",
      "rate_limit",
    ],
    [
      "bailian-token-plan",
      "insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "rate_limit",
    ],
    ["qwen", "PrepaidBillOverdue", "The prepaid bill is overdue.", "billing"],
    ["qwen", "rate_limit_error", "Rate limit exceeded", "rate_limit"],
    [
      "openai",
      "insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "billing",
    ],
    ["qwen", "insufficient_quota", "Free allocated quota exceeded.", "billing"],
    ["qwen", "insufficient_quota", "Unknown quota condition", "billing"],
  ])("classifies %s %s (%s) as %s", async (provider, code, message, reason, metadata) => {
    const result = await runThroughFailureRecovery({
      provider,
      providerOwner:
        provider === "openai"
          ? undefined
          : prepareProviderOwner(provider, provider === "openrouter" ? "openrouter" : "qwen"),
      fixture: { status: 429, code, message, ...(metadata ? { metadata } : {}) },
    });
    if (provider === "openrouter") {
      expectOpenRouterState(result, reason);
    } else if (reason === "rate_limit") {
      expectRateLimitState(result);
    } else {
      expectBillingState(result);
    }
  });
});
