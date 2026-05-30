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
});
