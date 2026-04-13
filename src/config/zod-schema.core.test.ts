import { describe, expect, it } from "vitest";
import { ModelApiSchema, ModelProviderSchema } from "./zod-schema.core.js";

describe("ModelApiSchema", () => {
  it("accepts openai-codex-responses", () => {
    expect(ModelApiSchema.safeParse("openai-codex-responses").success).toBe(true);
  });
});

describe("ModelProviderSchema", () => {
  it("accepts openai-codex-responses for provider configs", () => {
    const parsed = ModelProviderSchema.safeParse({
      baseUrl: "https://chatgpt.com/backend-api",
      auth: "oauth",
      api: "openai-codex-responses",
      models: [],
    });
    expect(parsed.success).toBe(true);
  });
});
