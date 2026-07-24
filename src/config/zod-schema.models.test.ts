// Verifies model config schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
  it.each([
    "claude-cli",
    "azure-openai-responses",
    "clawrouter",
    "gmi",
    "gmi-cloud",
    "gmicloud",
    "moonshot-ai",
    "moonshotai",
    "novita",
    "novita-ai",
    "novitaai",
    "ollama-cloud",
    "qwen-token-plan",
    "x-ai",
    "z.ai",
    "z-ai",
  ])("accepts bundled provider overlay for %s without baseUrl or models", (providerId) => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        [providerId]: {
          timeoutSeconds: 600,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each(["qwen-cli", "qwen-oauth", "qwen-portal"])(
    "rejects retired Qwen Portal provider overlay %s",
    (providerId) => {
      const result = ModelsConfigSchema.safeParse({
        providers: {
          [providerId]: {
            timeoutSeconds: 600,
          },
        },
      });

      expect(result.success).toBe(false);
    },
  );

  it("requires the legacy bailian-token-plan owner to remain an exact custom provider", () => {
    expect(
      ModelsConfigSchema.safeParse({
        providers: { "bailian-token-plan": { timeoutSeconds: 600 } },
      }).success,
    ).toBe(false);
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "bailian-token-plan": {
            api: "anthropic-messages",
            baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
            models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts google-vertex as a model API from MODEL_APIS", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "google-vertex": {
          baseUrl: "https://{location}-aiplatform.googleapis.com",
          api: "google-vertex",
          apiKey: "gcp-vertex-credentials",
          models: [
            {
              id: "gemini-2.5-pro",
              name: "Gemini 2.5 Pro",
              api: "google-vertex",
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts compat.requiresReasoningContentOnAssistantMessages (issue #89660)", () => {
    // The field is consumed at runtime (detectCompat/getCompat) and is present
    // in the ModelCompat type, but was missing from the strict Zod schema, so a
    // valid config replicating native DeepSeek behavior on a custom provider was
    // rejected with "Unrecognized key(s)". Use the exact config from the issue.
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              reasoning: true,
              compat: {
                thinkingFormat: "deepseek",
                requiresReasoningContentOnAssistantMessages: true,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  // Regression: the .strict() ModelCompatSchema was missing eight fields that
  // are present in ModelCompatConfig (TS type) and consumed at runtime. Setting
  // any of them caused the entire model definition to be rejected as invalid.
  // This is the same defect family as #89660 / #110065.
  it("accepts compat.supportsLongCacheRetention (issue #81281)", () => {
    // openai-completions-transport.ts:1726 reads this field to gate the
    // prompt_cache_retention header on API requests.
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              compat: { supportsLongCacheRetention: false },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts compat.openRouterRouting for routing header injection", () => {
    // openai-transport-params.ts:299 reads this to inject OpenRouter headers.
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "gemini-2.0-flash",
              name: "Gemini 2.0 Flash",
              compat: {
                openRouterRouting: { model: "google/gemini-2.0-flash" },
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts compat.vercelGatewayRouting for Vercel AI Gateway routing", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "claude-opus-4-8",
              name: "Claude Opus 4.8",
              compat: {
                vercelGatewayRouting: { model: "anthropic/claude-opus-4-8" },
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("still rejects unknown compat fields to maintain strictness", () => {
    // .strict() must still fire for truly unknown keys.
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "m1",
              name: "M1",
              compat: { nonexistentField: true },
            },
          ],
        },
      },
    } as unknown as Record<string, unknown>);

    expect(result.success).toBe(false);
  });

  // zaiToolStream is a boolean per the TS type (packages/llm-core/src/types.ts:465:
  // `zaiToolStream?: boolean`). Non-boolean values must fail schema validation.
  it("rejects a non-boolean zaiToolStream value", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "m1",
              name: "M1",
              compat: { zaiToolStream: "not-a-boolean" },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts catalog-declared temperature compatibility", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              compat: { supportsTemperature: false },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
