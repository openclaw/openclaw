import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../../agents/embedded-agent-runner/model.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { modelKey } from "../../shared/model-key.js";
import { resolveRunModelHasVision } from "./agent-runner-run-params.js";
import { resolveResponsesServerCompactionThreshold } from "./memory-flush.js";
import { createMockFollowupRun } from "./test-helpers.js";

const TEST_MODEL_ID = "gpt-5.4";
const TEST_CONTEXT_WINDOW = 200_000;
const OPENAI_URL = "https://api.openai.com/v1";
const AZURE_ROUTE = {
  provider: "azure-openai",
  api: "azure-openai-responses",
  baseUrl: "https://foo.openai.azure.com/openai/v1",
} as const;
const CUSTOM_THRESHOLD = { responsesCompactThreshold: 150_000 };
type CompactionRoute = Partial<
  Pick<ModelDefinitionConfig, "api" | "baseUrl" | "compat" | "contextTokens" | "contextWindow">
> & { provider?: string; preparedWindow?: number; extraParams?: Record<string, unknown> };

function buildModelConfig(route: Partial<ModelDefinitionConfig>): ModelDefinitionConfig {
  return {
    id: TEST_MODEL_ID,
    name: TEST_MODEL_ID,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: TEST_CONTEXT_WINDOW,
    maxTokens: 8_192,
    ...route,
  };
}

function providerConfig(
  provider: string,
  api: ModelDefinitionConfig["api"],
  models: ModelDefinitionConfig[],
  baseUrl = OPENAI_URL,
): OpenClawConfig["models"] {
  return { providers: { [provider]: { api, baseUrl, models } } };
}

describe("Responses server compaction host/transport parity", () => {
  it.each<[number | undefined, CompactionRoute]>([
    [560_000, { baseUrl: undefined, preparedWindow: 800_000 }],
    [112_000, { contextWindow: 1_000_000, preparedWindow: 160_000 }],
    [140_000, { baseUrl: undefined }],
    [190_400, { contextTokens: 272_000, contextWindow: 1_050_000 }],
    [140_000, {}],
    [
      undefined,
      {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        extraParams: CUSTOM_THRESHOLD,
      },
    ],
    [undefined, AZURE_ROUTE],
    [
      undefined,
      {
        ...AZURE_ROUTE,
        provider: "azure",
        baseUrl: "https://foo.cognitiveservices.azure.com/openai/v1",
      },
    ],
    [undefined, { compat: { supportsStore: false }, extraParams: CUSTOM_THRESHOLD }],
    [140_000, { provider: "OpenAI" }],
    [undefined, { baseUrl: "https://proxy.example.com/v1", extraParams: CUSTOM_THRESHOLD }],
    [undefined, { extraParams: { responsesServerCompaction: false } }],
    [
      150_000,
      { ...AZURE_ROUTE, extraParams: { ...CUSTOM_THRESHOLD, responsesServerCompaction: true } },
    ],
  ])("keeps threshold %s aligned for %j", (threshold, overrides) => {
    const { provider, api, baseUrl, preparedWindow, extraParams, ...modelOptions } = {
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: OPENAI_URL,
      ...overrides,
    };
    const { contextTokens, contextWindow } = modelOptions;
    const model = buildModelConfig({ api, baseUrl, ...modelOptions });
    const cfg: OpenClawConfig = {
      models: baseUrl === undefined ? undefined : providerConfig(provider, api, [model], baseUrl),
      agents: {
        defaults: { models: { [modelKey(provider, TEST_MODEL_ID)]: { params: extraParams } } },
      },
    };
    const hostThreshold = resolveResponsesServerCompactionThreshold({
      contextWindowTokens: preparedWindow ?? contextTokens ?? contextWindow ?? TEST_CONTEXT_WINDOW,
      cfg,
      provider,
      modelId: TEST_MODEL_ID,
    });
    const payload: Record<string, unknown> = {};
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        id: TEST_MODEL_ID,
        provider,
        api,
        baseUrl: baseUrl ?? OPENAI_URL,
        compat: model.compat,
        contextTokens: contextTokens ?? preparedWindow,
        contextWindow: contextWindow ?? preparedWindow ?? TEST_CONTEXT_WINDOW,
      },
      {
        storeMode: "provider-policy",
        enableServerCompaction: true,
        extraParams,
      },
    );
    applyOpenAIResponsesPayloadPolicy(payload, policy);
    const transportEnabled = payload.context_management !== undefined;

    expect({ hostThreshold, transportEnabled, policyThreshold: policy.compactThreshold }).toEqual({
      hostThreshold: threshold,
      transportEnabled: threshold !== undefined,
      policyThreshold: threshold,
    });
  });
});

describe("configured model consumer parity", () => {
  it.each([
    [false, "Model", true, 140_000],
    [false, "model", false, 700_000],
    [true, "Model", true, 140_000],
    [true, "model", false, 700_000],
    [false, "MODEL", true, 140_000],
  ] as const)(
    "matches transport with reversed=%s, model=%s",
    async (reverse, modelId, vision, threshold) => {
      const upper: ModelDefinitionConfig = {
        ...buildModelConfig({ api: "openai-responses", contextTokens: 200_000 }),
        id: "Model",
        input: ["text", "image"],
      };
      const lower: ModelDefinitionConfig = {
        ...upper,
        id: "model",
        input: ["text"],
        contextTokens: 1_000_000,
        contextWindow: 1_000_000,
      };
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        models: providerConfig(
          "openai",
          "openai-responses",
          modelId === "MODEL" ? [upper] : reverse ? [lower, upper] : [upper, lower],
        ),
      };
      const { run } = createMockFollowupRun({
        run: { config: cfg, provider: "openai", model: modelId },
      });
      await withPluginMetadataSnapshotScope(
        createPluginMetadataSnapshotFixture(),
        async () => {
          const transportId = modelId === "MODEL" ? upper.id : modelId;
          const { model } = await resolveModelAsync("openai", transportId, run.agentDir, cfg, {
            ...createEmptyAgentDiscoveryStores(),
            workspaceDir: run.workspaceDir,
          });
          const transportModel = expectDefined(model, "configured transport model");
          const policy = resolveOpenAIResponsesPayloadPolicy(transportModel, {
            storeMode: "provider-policy",
            enableServerCompaction: true,
          });
          expect(transportModel.id).toBe(transportId);
          expect(transportModel.input.includes("image")).toBe(vision);
          expect(policy.compactThreshold).toBe(threshold);
          expect({
            vision: await resolveRunModelHasVision({ run, provider: "openai", model: modelId }),
            threshold: resolveResponsesServerCompactionThreshold({
              cfg,
              provider: "openai",
              modelId,
              contextWindowTokens: expectDefined(
                transportModel.contextWindow,
                "configured transport context window",
              ),
            }),
          }).toEqual({ vision, threshold });
        },
        { config: cfg },
      );
    },
  );
});

describe("Anthropic server compaction host threshold", () => {
  const modelId = "claude-sonnet-4-6";
  const enabled = { anthropicServerCompaction: true };

  it.each([
    ["keeps the local threshold for default-on compaction", {}, 200_000, undefined],
    ["uses 70 percent of the context window", enabled, 200_000, 140_000],
    ["uses the minimum for small windows", enabled, 32_000, 50_000],
    ["clamps low thresholds", { ...enabled, anthropicCompactThreshold: 42_000 }, 200_000, 50_000],
    ["uses custom thresholds", { ...enabled, anthropicCompactThreshold: 80_000 }, 200_000, 80_000],
    ["uses a prepared-only window for its enabled server floor", enabled, undefined, 700_000],
  ] as const)("%s", (_name, params, contextWindowTokens, expected) => {
    const cfg: OpenClawConfig = {
      models: providerConfig(
        "anthropic",
        "anthropic-messages",
        contextWindowTokens === undefined
          ? []
          : [buildModelConfig({ id: modelId, name: modelId, contextWindow: contextWindowTokens })],
        "https://api.anthropic.com/v1",
      ),
      agents: { defaults: { params } },
    };

    expect(
      resolveResponsesServerCompactionThreshold({
        contextWindowTokens: contextWindowTokens === undefined ? 1_000_000 : 100_000,
        cfg,
        provider: "anthropic",
        modelId: contextWindowTokens === undefined ? "claude-opus-4-6" : modelId,
      }),
    ).toBe(expected);
  });
});
