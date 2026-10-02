import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it } from "vitest";
import { readPersistedAuthProfileStateRaw } from "../../src/agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../src/agents/auth-profiles/store-runtime.js";
import { isProfileInCooldown } from "../../src/agents/auth-profiles/usage-state.js";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
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
  reason: string | null;
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
        config: {},
      };
      const failover = createEmbeddedRunFailoverRetryController({
        runParams: runParams as never,
        provider: params.provider,
        modelId: MODEL_ID,
        globalLane: "qwen-dashscope-throttle-test",
        agentDir: state.agentDir(),
        fallbackConfigured: false,
        profileFailureStore: profileStore,
        getLastProfileId: () => profileId,
        getSessionId: () => sessionId,
        harnessOwnsTransport: () => false,
        getRuntimeAuthOwnerId: () => "embedded",
        getApiKeyInfo: () => null,
        advanceAuthProfile: async () => false,
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
          runParams: runParams as never,
          attempt,
          attemptAssistant: assistant,
          currentAttemptAssistant: assistant,
          terminalState,
          activeErrorContext: { provider: params.provider, model: MODEL_ID },
          provider: params.provider,
          providerOwner: params.providerOwner,
          modelId: MODEL_ID,
          model: MODEL_ID,
          thinkLevel: "off",
          getThinkLevel: () => "off",
          attemptedThinking: new Set(["off"]),
          fallbackConfigured: false,
          pluginHarnessOwnsTransport: false,
          authProfileId: profileId,
          authProfileStore: profileStore,
          runtimeAuthRetry: false,
          maybeRefreshRuntimeAuthForAuthError: async () => false,
          failover,
          emptyErrorRetries: 0,
          overloadProfileRotations: 0,
          previousRetryFailoverReason: null,
          traceAttempts: [],
          suspendForFailure: ({ reason }) => {
            suspensionReasons.push(reason);
          },
          suspensionSessionId: sessionId,
          agentDir: state.agentDir(),
          isProbeSession: false,
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
      const result = {
        reason: classifyAssistantFailoverReason(assistant, {
          providerOwner: params.providerOwner,
        }),
        failureReason,
        usage: persisted?.usageStats?.[profileId],
        affectedModelBlocked: isProfileInCooldown(freshStore, profileId, undefined, MODEL_ID),
        otherModelBlocked: isProfileInCooldown(freshStore, profileId, undefined, "qwen3.8-flash"),
        suspensionReasons,
      };
      console.info(
        "DASHSCOPE_PROFILE_PROOF",
        JSON.stringify({
          provider: params.provider,
          code: params.fixture.code,
          preparedOwner: params.providerOwner?.id ?? null,
          ...result,
        }),
      );
      return result;
    },
  );
}

function expectRateLimitState(result: Awaited<ReturnType<typeof runThroughFailureRecovery>>): void {
  expect.soft(result.reason).toBe("rate_limit");
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
  expect.soft(result.reason).toBe("billing");
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
  expect.soft(result.reason).toBe(reason);
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
  it("keeps registered OpenRouter wrapper errors in the rate-limit lane", async () => {
    const providerOwner = prepareProviderOwner("openrouter", "openrouter");
    expect(
      providerOwner.classifyFailoverReason?.({
        provider: "openrouter",
        status: 429,
        errorMessage: "Provider returned error",
      }),
    ).toBe("timeout");
    const result = await runThroughFailureRecovery({
      provider: "openrouter",
      providerOwner,
      fixture: { status: 429, code: 429, message: "Provider returned error" },
    });
    expectOpenRouterState(result, "rate_limit");
  });

  it("keeps registered OpenRouter upstream billing inside metadata.raw in the billing lane", async () => {
    const result = await runThroughFailureRecovery({
      provider: "openrouter",
      providerOwner: prepareProviderOwner("openrouter", "openrouter"),
      fixture: {
        status: 429,
        code: 429,
        message: "Provider returned error",
        metadata: { raw: '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}' },
      },
    });
    expectOpenRouterState(result, "billing");
  });

  it("preserves the registered OpenRouter explicit key-budget billing decision", async () => {
    const result = await runThroughFailureRecovery({
      provider: "openrouter",
      providerOwner: prepareProviderOwner("openrouter", "openrouter"),
      fixture: { status: 429, code: 429, message: "API key budget limit exceeded" },
    });
    expectOpenRouterState(result, "billing");
  });

  it.each([
    {
      provider: QWEN_TOKEN_PLAN_PROVIDER_ID,
      code: "insufficient_quota",
      message: "Allocated quota exceeded, please increase your quota limit.",
    },
    {
      provider: "qwen",
      code: "Throttling.AllocationQuota",
      message: "Allocated quota exceeded, please increase your quota limit.",
    },
    {
      provider: "bailian-token-plan",
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    },
  ])("keeps $provider $code in the model-scoped rate-limit lane", async (fixture) => {
    const result = await runThroughFailureRecovery({
      provider: fixture.provider,
      providerOwner: prepareProviderOwner(fixture.provider),
      fixture: { status: 429, code: fixture.code, message: fixture.message },
    });
    expectRateLimitState(result);
  });

  it.each(["PrepaidBillOverdue", "PostpaidBillOverdue"])(
    "keeps explicit Qwen %s in the billing lane",
    async (code) => {
      const result = await runThroughFailureRecovery({
        provider: "qwen",
        providerOwner: prepareProviderOwner("qwen"),
        fixture: {
          status: 429,
          code,
          message: "The prepaid bill is overdue.",
        },
      });
      expectBillingState(result);
    },
  );

  it("keeps an ordinary Qwen HTTP 429 in the generic rate-limit lane", async () => {
    const result = await runThroughFailureRecovery({
      provider: "qwen",
      providerOwner: prepareProviderOwner("qwen"),
      fixture: { status: 429, code: "rate_limit_error", message: "Rate limit exceeded" },
    });
    expectRateLimitState(result);
  });

  it("does not reinterpret another provider's insufficient_quota semantics", async () => {
    const result = await runThroughFailureRecovery({
      provider: "openai",
      fixture: {
        status: 429,
        code: "insufficient_quota",
        message: "You exceeded your current quota, please check your plan and billing details.",
      },
    });
    expectBillingState(result);
  });

  it.each(["Free allocated quota exceeded.", "Unknown quota condition"])(
    "does not reinterpret non-throttling quota evidence: %s",
    async (message) => {
      const result = await runThroughFailureRecovery({
        provider: "qwen",
        providerOwner: prepareProviderOwner("qwen"),
        fixture: { status: 429, code: "insufficient_quota", message },
      });
      expectBillingState(result);
    },
  );
});
