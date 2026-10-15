import { afterEach, expect, it, vi } from "vitest";
import * as modelRuntime from "../agents/embedded-agent-runner/model.js";
import { prepareEmbeddedRunAuthPlan } from "../agents/embedded-agent-runner/run/auth-plan.js";
import type { AgentHarness } from "../agents/harness/types.js";
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

it.each(["profile", "environment"] as const)(
  "refuses legacy adoption from current %s credentials at the auth boundary",
  async (source) => {
    await withOpenClawTestState(
      {
        label: "cron-unbound-auth",
        env: { OPENAI_API_KEY: source === "environment" ? "synthetic-env-key" : undefined },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles:
            source === "profile"
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
          withPluginRuntimeGenerationScope(
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
          ),
        ).rejects.toThrow("Automation has no recorded inference account");
        expect(materialize).not.toHaveBeenCalled();
      },
    );
  },
);

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
