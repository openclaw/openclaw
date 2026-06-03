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

  // Regression: https://github.com/openclaw/openclaw/issues/89660
  // ModelCompatSchema is .strict(); user-facing compat flags consumed at
  // runtime by detectCompat()/getCompat() must be present in the schema or
  // gateway startup rejects the config with "Unrecognized key(s) in object".
  it.each([
    [
      "requiresReasoningContentOnAssistantMessages",
      { requiresReasoningContentOnAssistantMessages: true },
    ],
    [
      "requiresReasoningContentOnAssistantMessages set to false",
      { requiresReasoningContentOnAssistantMessages: false },
    ],
    [
      "thinkingFormat=deepseek + requiresReasoningContentOnAssistantMessages",
      {
        thinkingFormat: "deepseek" as const,
        requiresReasoningContentOnAssistantMessages: true,
      },
    ],
  ])("accepts custom provider compat with %s", (_label, compat) => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              reasoning: true,
              compat,
            },
          ],
        },
      },
    });

    if (!result.success) {
      throw new Error(
        `Schema rejected compat ${JSON.stringify(compat)}: ${JSON.stringify(result.error.issues)}`,
      );
    }
    const provider = result.data?.providers?.["my-proxy"];
    const model = provider?.models?.[0];
    if (!model) throw new Error("model missing from parsed config");
    expect(model.compat).toMatchObject(compat);
  });

  it("rejects truly unrecognized compat keys (sanity check that .strict() still holds)", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "x",
              name: "X",
              compat: { totallyMadeUpCompatKey: true } as unknown as Record<string, unknown>,
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
