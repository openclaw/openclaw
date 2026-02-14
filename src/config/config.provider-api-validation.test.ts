import { describe, expect, it } from "vitest";
import { ModelProviderSchema } from "./zod-schema.core.js";

describe("ModelProviderSchema api field validation", () => {
  it("warns when provider has models but no api field", () => {
    const result = ModelProviderSchema.safeParse({
      baseUrl: "http://localhost:4000/v1",
      apiKey: "test-key",
      models: [
        {
          id: "my-model",
          name: "My Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const apiIssue = result.error.issues.find(
        (i) => i.path.includes("api") && i.message.includes('Missing "api" field'),
      );
      expect(apiIssue).toBeDefined();
      // Verify all valid API types are listed (pulled from ModelApiSchema at runtime)
      expect(apiIssue!.message).toContain("openai-completions");
      expect(apiIssue!.message).toContain("openai-responses");
      expect(apiIssue!.message).toContain("anthropic-messages");
      expect(apiIssue!.message).toContain("google-generative-ai");
      expect(apiIssue!.message).toContain("github-copilot");
      expect(apiIssue!.message).toContain("bedrock-converse-stream");
      expect(apiIssue!.message).toContain("ollama");
    }
  });

  it("accepts provider with api field set", () => {
    const result = ModelProviderSchema.safeParse({
      baseUrl: "http://localhost:4000/v1",
      apiKey: "test-key",
      api: "openai-completions",
      models: [
        {
          id: "my-model",
          name: "My Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts provider with empty models array and no api", () => {
    const result = ModelProviderSchema.safeParse({
      baseUrl: "http://localhost:4000/v1",
      models: [],
    });

    expect(result.success).toBe(true);
  });

  it("accepts provider when all models have their own api field", () => {
    const result = ModelProviderSchema.safeParse({
      baseUrl: "http://localhost:4000/v1",
      apiKey: "test-key",
      models: [
        {
          id: "my-model",
          name: "My Model",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("warns when some models lack api and provider has no api", () => {
    const result = ModelProviderSchema.safeParse({
      baseUrl: "http://localhost:4000/v1",
      apiKey: "test-key",
      models: [
        {
          id: "model-with-api",
          name: "Model A",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
        {
          id: "model-without-api",
          name: "Model B",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const apiIssue = result.error.issues.find(
        (i) => i.path.includes("api") && i.message.includes('Missing "api" field'),
      );
      expect(apiIssue).toBeDefined();
    }
  });
});
