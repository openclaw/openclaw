import { afterEach, expect, it, vi } from "vitest";
import * as modelRuntime from "../agents/embedded-agent-runner/model.js";
import { prepareEmbeddedRunAuthPlan } from "../agents/embedded-agent-runner/run/auth-plan.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const harness: AgentHarness = {
  id: "openclaw",
  label: "Synthetic scheduled auth",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("Auth preparation must not contact a provider");
  },
};
const model: Model = {
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
};
afterEach(() => vi.restoreAllMocks());

function prepareAuth(
  state: OpenClawTestState,
  stores: ReturnType<typeof modelRuntime.createEmptyAgentDiscoveryStores>,
  runParams: Parameters<typeof prepareEmbeddedRunAuthPlan>[0]["runParams"],
  selectedModel = model,
  nativeModelOwned = false,
) {
  return withPluginRuntimeGenerationScope(
    { metadataSnapshot: createPluginMetadataSnapshotFixture() },
    () =>
      prepareEmbeddedRunAuthPlan({
        assertCurrent() {},
        runParams,
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        model: selectedModel,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        nativeModelOwned,
        ...(nativeModelOwned
          ? {
              nativeSessionRuntime: {
                auth: "native" as const,
                harness,
                assertCurrent: async () => {},
              },
            }
          : {}),
        ...stores,
        getAgentHarness: () => harness,
        setAgentHarness() {},
        getRuntimeModel: () => selectedModel,
        getEffectiveModel: () => selectedModel,
        applyResolvedRuntimeModel() {},
        selectHarnessForPreparedAttempts: () => harness,
      }),
  );
}

it.each(["cron", "event"] as const)(
  "keeps a configured direct credential on the %s auth boundary",
  async (trigger) => {
    await withOpenClawTestState(
      { label: "immediate-event-auth", env: { OPENAI_API_KEY: undefined } },
      async (state) => {
        await state.writeAuthProfiles({ version: 1, profiles: {} });
        const stores = modelRuntime.createEmptyAgentDiscoveryStores();
        vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
          ...stores,
          model,
          logicalRef: { provider: model.provider, model: model.id },
        });
        const prepared = await prepareAuth(state, stores, {
          sessionId: "immediate-event",
          runId: "immediate-event",
          workspaceDir: state.workspaceDir,
          prompt: "Synthetic immediate event",
          timeoutMs: 1_000,
          trigger,
          config: {
            models: {
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: "synthetic-configured-event-key",
                  baseUrl: model.baseUrl,
                  models: [],
                },
              },
            },
          },
        });
        expect(prepared.preparedAuthAttempts).toMatchObject([
          {
            kind: "direct",
            plan: { credentialSource: { kind: "direct", evidence: "provider-config" } },
          },
        ]);
        expect(prepared.lockedProfileId).toBeUndefined();
      },
    );
  },
);

const bedrockModel: Model = {
  ...model,
  id: "anthropic.claude-sonnet",
  provider: "amazon-bedrock",
  api: "bedrock-converse-stream",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
};

const awsSdkConfig = {
  models: {
    providers: {
      "amazon-bedrock": {
        api: "bedrock-converse-stream" as const,
        auth: "aws-sdk" as const,
        baseUrl: bedrockModel.baseUrl,
        models: [],
      },
    },
  },
};

it.each([
  { source: "a current stored account", model, storedProfile: true, config: {} },
  {
    source: "ambient AWS SDK credentials",
    model: bedrockModel,
    storedProfile: false,
    config: awsSdkConfig,
  },
])("refuses legacy adoption from $source at the auth boundary", async (testCase) => {
  await withOpenClawTestState(
    { label: "cron-unbound-auth", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: testCase.storedProfile
          ? {
              "openai:current": {
                type: "api_key",
                provider: "openai",
                key: "synthetic-current-key",
              },
            }
          : {},
      });
      const materialize = vi.spyOn(modelRuntime, "resolveModelAsync");
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      await expect(
        prepareAuth(
          state,
          stores,
          {
            sessionId: "fresh-legacy-fire",
            runId: "legacy-fire",
            workspaceDir: state.workspaceDir,
            prompt: "Synthetic scheduled work",
            timeoutMs: 1_000,
            trigger: "cron",
            config: testCase.config,
          },
          testCase.model,
        ),
      ).rejects.toThrow("Automation has no recorded inference account");
      expect(materialize).not.toHaveBeenCalled();
    },
  );
});

it.each(["native", "credentialless", "synthetic-marker"] as const)(
  "keeps %s execution without adopting an ambient host account",
  async (kind) => {
    await withOpenClawTestState(
      { label: "cron-native-auth", env: { OPENAI_API_KEY: "synthetic-ambient-key" } },
      async (state) => {
        await state.writeAuthProfiles({ version: 1, profiles: {} });
        const selectedModel: Model =
          kind === "native"
            ? model
            : { ...model, provider: "ollama", api: "ollama", baseUrl: "http://localhost:11434" };
        const stores = modelRuntime.createEmptyAgentDiscoveryStores();
        vi.spyOn(modelRuntime, "resolveModelAsync").mockResolvedValue({
          ...stores,
          model: selectedModel,
          logicalRef: { provider: selectedModel.provider, model: selectedModel.id },
        });
        const prepared = await prepareAuth(
          state,
          stores,
          {
            sessionId: "native-fire",
            runId: "native-fire",
            workspaceDir: state.workspaceDir,
            prompt: "Synthetic native work",
            timeoutMs: 1_000,
            trigger: "cron",
            config:
              kind === "synthetic-marker"
                ? {
                    models: {
                      providers: {
                        ollama: {
                          api: "ollama",
                          apiKey: "ollama-local",
                          baseUrl: selectedModel.baseUrl,
                          models: [],
                        },
                      },
                    },
                  }
                : {},
          },
          selectedModel,
          kind === "native",
        );
        expect(prepared.preparedAuthAttempts).toMatchObject(
          kind === "synthetic-marker"
            ? [
                {
                  kind: "direct",
                  plan: { credentialSource: { kind: "direct", evidence: "synthetic" } },
                },
              ]
            : [{ kind: "implicit" }],
        );
        expect(prepared.lockedProfileId).toBeUndefined();
      },
    );
  },
);
