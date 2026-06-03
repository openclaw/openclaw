import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
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

  it("accepts compat.requiresReasoningContentOnAssistantMessages on a model", () => {
    // Regression for #89660: the flag is honored at runtime (getCompat) but was
    // missing from the strict ModelCompatSchema, so configuring it to replicate
    // native DeepSeek behavior on a custom proxy failed gateway startup.
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

  it("still rejects unknown compat keys (strict schema preserved)", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              compat: { definitelyNotARealCompatKey: true },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
