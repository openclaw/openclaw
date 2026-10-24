import { createServer } from "node:http";
import path from "node:path";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../src/agents/auth-profiles/credential-fixtures.test-support.js";
import { readPersistedAuthProfileStateRaw } from "../../src/agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../src/agents/auth-profiles/store-runtime.js";
import type { AuthProfileState } from "../../src/agents/auth-profiles/types.js";
import { isProfileInCooldown } from "../../src/agents/auth-profiles/usage-state.js";
import { handleEmbeddedAssistantFailure } from "../../src/agents/embedded-agent-runner/run/assistant-failure.js";
import { makeAssistantFailureInput } from "../../src/agents/embedded-agent-runner/run/assistant-failure.test-support.js";
import { createEmbeddedRunFailoverRetryController } from "../../src/agents/embedded-agent-runner/run/failover-retry-controller.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../src/agents/embedded-agent-runner/run/terminal-outcome.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { withPluginMetadataSnapshotScope } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { loadPluginManifestRegistryCore } from "../../src/plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../../src/plugins/types.js";
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
import { loadBundledProviderPlugin } from "../helpers/media-generation/bundled-provider-builders.js";

const MODEL_ID = "qwen3.8-max";
const QWEN_TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan";

const model = makeProviderModelFixture<"openai-completions">({
  id: MODEL_ID,
  api: "openai-completions",
  provider: QWEN_TOKEN_PLAN_PROVIDER_ID,
  baseUrl: "",
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
    const plugin = await loadBundledProviderPlugin(pluginId);
    const { providers } = await registerProviderPlugin({ plugin, id: pluginId, name: pluginId });
    registeredProviders.set(pluginId, providers);
  }
});

type ErrorFixture = {
  status: number;
  code: string | number;
  message: string;
  metadata?: { raw: string };
};

async function runThroughFailureRecovery(
  {
    provider,
    providerOwner,
    fixture,
  }: {
    provider: string;
    providerOwner?: ProviderPlugin;
    fixture: ErrorFixture;
  },
  snapshot = availabilitySnapshot,
) {
  return withPluginMetadataSnapshotScope(
    snapshot,
    async () => {
      const server = createServer((request, response) => {
        request.resume();
        respondJson(
          response,
          {
            error: {
              code: fixture.code,
              type: fixture.code,
              message: fixture.message,
              ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
            },
          },
          fixture.status,
        );
      });
      const baseUrl = `${await listenLoopback(server)}/compatible-mode/v1`;
      let assistant;
      try {
        assistant = await streamOpenAICompletions(
          { ...model, provider, baseUrl },
          { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
          { apiKey: "synthetic-test-key" },
        ).result();
      } finally {
        await closeHttpServer(server);
      }
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
      return await withOpenClawTestState(
        { label: `qwen-dashscope-${provider.replaceAll(/[^a-z0-9]+/gi, "-")}` },
        async (state) => {
          const profileId = `${provider}:fixture`;
          const agentDir = state.agentDir();
          const profileStore = createAuthProfileStoreFixture({
            [profileId]: createApiKeyCredential(provider, "synthetic-test-key"),
          });
          await state.writeAuthProfiles(profileStore);
          const sessionId = `session:${provider}:${fixture.code}`;
          const input = makeAssistantFailureInput(assistant, {
            profileId,
            fallbackConfigured: false,
          });
          const { runInput, preparedRuntime, runtime, normalizedAttempt } = input;
          Object.assign(runInput.runParams, {
            runId: `run:${provider}:${fixture.code}`,
            sessionId,
            sessionKey: `agent:main:${provider}:${fixture.code}`,
            sessionFile: `${agentDir}/session.jsonl`,
            workspaceDir: agentDir,
            prompt: "hello",
            config: {},
          });
          const suspensionReasons: string[] = [];
          const controllerRunInput = Object.assign(runInput, {
            agentDir,
            globalLane: "qwen-dashscope-throttle-test",
            suspendForFailure: ({ reason }: { reason: string }) => {
              suspensionReasons.push(reason);
            },
          });
          runtime.thinkLevel = "off";
          const controllerRuntime = Object.assign(preparedRuntime, {
            attemptedThinking: new Set([runtime.thinkLevel]),
            attemptAuthProfileStore: profileStore,
            profileFailureStore: profileStore,
            snapshot: () => ({ ...runtime, agentHarness: { id: "embedded" } }),
            getApiKeyInfo: () => null,
            advanceAttemptAuthProfile: async () => false,
          });
          normalizedAttempt.attempt.messagesSnapshot = [assistant];
          normalizedAttempt.terminalState = resolveEmbeddedRunAttemptTerminalState({
            attempt: normalizedAttempt.attempt,
            assistant,
          });
          input.providerOwner = providerOwner;
          input.getThinkLevel = () => "off";
          input.suspensionSessionId = sessionId;
          input.failover = createEmbeddedRunFailoverRetryController({
            runInput: controllerRunInput,
            preparedRuntime: controllerRuntime,
            getSessionId: () => sessionId,
          });
          let failureReason: unknown;
          try {
            await handleEmbeddedAssistantFailure(input);
          } catch (error) {
            failureReason =
              typeof error === "object" && error !== null && "reason" in error
                ? Reflect.get(error, "reason")
                : undefined;
          }
          const persisted = readPersistedAuthProfileStateRaw(agentDir) as AuthProfileState | null;
          const freshStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
          expect(freshStore.usageStats?.[profileId]).toEqual(persisted?.usageStats?.[profileId]);
          const blocked = (id: string) => isProfileInCooldown(freshStore, profileId, undefined, id);
          return {
            failureReason,
            usage: persisted?.usageStats?.[profileId],
            affectedModelBlocked: blocked(MODEL_ID),
            otherModelBlocked: blocked("qwen3.8-flash"),
            suspensionReasons,
          };
        },
      );
    },
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
  // These throttles carry no provider retry timing, so a rate limit blocks no model.
  expect.soft(result).toMatchObject({
    failureReason: reason,
    affectedModelBlocked: billing,
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
      : { lastRateLimitAt: expect.any(Number) },
  );
  for (const key of billing
    ? ["cooldownReason"]
    : ["cooldownReason", "cooldownUntil", "disabledReason", "disabledUntil"]) {
    expect.soft(result.usage).not.toHaveProperty(key);
  }
}

const selfManagedProvider = "self-managed-fixture";
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    { id: selfManagedProvider, providers: [selfManagedProvider], managesOwnAvailability: true },
  ],
});
it.each([
  { status: 429, message: "Too many requests", reason: "rate_limit", transient: true },
  { status: 503, message: "Provider overloaded", reason: "overloaded", transient: true },
  { status: 401, message: "Invalid API key", reason: "auth", transient: false },
  { status: 402, message: "Insufficient credits", reason: "billing", transient: false },
] as const)(
  "self-managed provider policy after HTTP $status",
  async ({ status, message, reason, transient }) => {
    const result = await runThroughFailureRecovery(
      {
        provider: selfManagedProvider,
        fixture: { status, code: status, message },
      },
      snapshot,
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
const quotaCode = "insufficient_quota";
const allocated = "Allocated quota exceeded, please increase your quota limit.";
const exceeded = "You exceeded your current quota, please check your plan and billing details.";
it.each([
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
] as const)(
  "%s %s (%s) classifies as %s",
  async (...[provider, code, message, reason, metadata]) => {
    const result = await runThroughFailureRecovery({
      provider,
      providerOwner:
        provider === "openai"
          ? undefined
          : requireRegisteredProvider(
              registeredProviders.get(provider === "openrouter" ? "openrouter" : "qwen") ?? [],
              provider,
            ),
      fixture: { status: 429, code, message, ...(metadata ? { metadata } : {}) },
    });
    expectFailureState(result, reason, provider === "openrouter");
  },
);
