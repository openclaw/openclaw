import { afterEach, expect, it, vi } from "vitest";
import * as modelRuntime from "../agents/embedded-agent-runner/model.js";
import { prepareEmbeddedRunAuthPlan } from "../agents/embedded-agent-runner/run/auth-plan.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { isRecordedModelFallbackStop } from "../agents/model-fallback-stop.js";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

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

it.each(["cron", "event"] as const)(
  "keeps configured direct credentials on the correct %s auth boundary",
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
        const prepare = () =>
          withPluginRuntimeGenerationScope(
            { metadataSnapshot: createPluginMetadataSnapshotFixture() },
            () =>
              prepareEmbeddedRunAuthPlan({
                assertCurrent() {},
                runParams: {
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
                },
                provider: model.provider,
                modelId: model.id,
                model,
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                nativeModelOwned: false,
                ...stores,
                getAgentHarness: () => harness,
                setAgentHarness() {},
                getRuntimeModel: () => model,
                getEffectiveModel: () => model,
                applyResolvedRuntimeModel() {},
                selectHarnessForPreparedAttempts: () => harness,
              }),
          );

        const prepared = await prepare();
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

it("refuses legacy adoption from a current stored account at the auth boundary", async () => {
  await withOpenClawTestState(
    {
      label: "cron-unbound-auth",
      env: { OPENAI_API_KEY: undefined },
    },
    async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "openai:current": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-current-key",
          },
        },
      });
      const materialize = vi.spyOn(modelRuntime, "resolveModelAsync");
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      const refusal = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: createPluginMetadataSnapshotFixture() },
        () =>
          prepareEmbeddedRunAuthPlan({
            assertCurrent() {},
            runParams: {
              sessionId: "fresh-legacy-fire",
              runId: "legacy-fire",
              workspaceDir: state.workspaceDir,
              prompt: "Synthetic scheduled work",
              timeoutMs: 1_000,
              trigger: "cron",
              config: {},
            },
            provider: model.provider,
            modelId: model.id,
            model,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            ...stores,
            getAgentHarness: () => harness,
            setAgentHarness() {},
            getRuntimeModel: () => model,
            getEffectiveModel: () => model,
            applyResolvedRuntimeModel() {},
            selectHarnessForPreparedAttempts: () => harness,
          }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("Automation has no recorded inference account"),
        }),
      );
      expect(isRecordedModelFallbackStop(refusal)).toBe(true);
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
        const prepared = await withPluginRuntimeGenerationScope(
          { metadataSnapshot: createPluginMetadataSnapshotFixture() },
          () =>
            prepareEmbeddedRunAuthPlan({
              assertCurrent() {},
              runParams: {
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
              provider: selectedModel.provider,
              modelId: selectedModel.id,
              model: selectedModel,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              nativeModelOwned: kind === "native",
              ...(kind === "native"
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
