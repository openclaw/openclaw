import { expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../../packages/ai/src/transports/openai-completions-params.js";
import { makeCompletionsModel } from "../../packages/ai/src/transports/openai-completions.test-support.js";
import { applyModelDefaults } from "./defaults.js";
import type { ModelDefinitionConfig } from "./types.js";
import { validateConfigObjectRaw } from "./validation-core.js";

it.each([
  { name: "unknown limit", row: {}, expected: 32768 },
  { name: "authored cap", row: { maxTokens: 4096 }, expected: 4096 },
  { name: "served window", row: { contextTokens: 16384 }, expected: 8192 },
  { name: "provider cap", row: {}, providerCap: 2048, expected: 2048 },
  { name: "request override", row: {}, requestCap: 1024, expected: 1024 },
  { name: "native parameter override", row: { params: { max_tokens: 2048 } }, expected: 2048 },
])(
  "sends the $name from config to the managed OpenAI request",
  ({ row, providerCap, requestCap, expected }) => {
    const config = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:8000/v1",
            api: "openai-completions",
            maxTokens: providerCap,
            models: [{ id: "unknown-local", name: "Unknown local", contextWindow: 131072, ...row }],
          },
        },
      },
    };
    const before = structuredClone(config);
    const parsed = validateConfigObjectRaw(config);
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.issues));
    }
    const resolved: ModelDefinitionConfig | undefined = applyModelDefaults(parsed.config, {
      manifestRegistry: { plugins: [] },
    }).models?.providers?.custom?.models[0];
    if (!resolved) {
      throw new Error("missing defaulted model");
    }
    const model = makeCompletionsModel({
      id: resolved.id,
      name: resolved.name,
      contextWindow: resolved.contextWindow,
      maxTokens: resolved.maxTokens,
      params: resolved.params,
      api: "openai-completions",
      provider: "custom",
      baseUrl: "http://localhost:8000/v1",
      compat: { maxTokensField: "max_tokens" },
    });
    const request = buildOpenAICompletionsParams(
      model,
      { messages: [] },
      requestCap === undefined ? undefined : { maxTokens: requestCap },
    );
    expect(request.max_tokens).toBe(expected);
    expect(config).toEqual(before);
  },
);
