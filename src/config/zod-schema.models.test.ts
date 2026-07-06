// Verifies model config schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
  it.each([
    "claude-cli",
    "azure-openai-responses",
    "gmi",
    "gmi-cloud",
    "gmicloud",
    "moonshot-ai",
    "moonshotai",
    "novita",
    "novita-ai",
    "novitaai",
    "ollama-cloud",
    "qwen-cli",
    "qwen-oauth",
    "qwen-portal",
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
});

import { AgentModelSchema, AgentToolModelSchema } from "./zod-schema.agent-model.js";

describe("AgentModelSchema nullable fallbacks", () => {
  it("accepts null fallbacks (clear-to-inherit)", () => {
    const result = AgentModelSchema.safeParse({ primary: "openai/gpt-5", fallbacks: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fallbacks).toBeNull();
  });
  it("accepts fallbacks as array", () => {
    const result = AgentModelSchema.safeParse({
      primary: "openai/gpt-5",
      fallbacks: ["anthropic/claude-haiku-3-5"],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fallbacks).toEqual(["anthropic/claude-haiku-3-5"]);
  });
  it("rejects non-array non-null fallbacks", () => {
    const result = AgentModelSchema.safeParse({
      primary: "openai/gpt-5",
      fallbacks: "not-an-array",
    });
    expect(result.success).toBe(false);
  });
  it("accepts string-only model (no fallbacks field)", () => {
    const result = AgentModelSchema.safeParse("openai/gpt-5");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("openai/gpt-5");
  });
});

describe("AgentToolModelSchema nullable fallbacks", () => {
  it("accepts null fallbacks", () => {
    const result = AgentToolModelSchema.safeParse({ primary: "openai/gpt-5", fallbacks: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fallbacks).toBeNull();
  });
  it("accepts fallbacks as array", () => {
    const result = AgentToolModelSchema.safeParse({
      primary: "openai/gpt-5",
      fallbacks: ["anthropic/claude-haiku-3-5"],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fallbacks).toEqual(["anthropic/claude-haiku-3-5"]);
  });
});

