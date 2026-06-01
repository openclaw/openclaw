import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { testing } from "./azure-openai-responses.js";

const azureResponsesModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "azure-openai-responses",
  provider: "azure",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"azure-openai-responses">;

describe("azure-openai-responses", () => {
  it("keeps traditional Azure OpenAI hosts on the AzureOpenAI client path", () => {
    const config = testing.resolveAzureConfig(azureResponsesModel, {
      azureResourceName: "example",
      azureApiVersion: "v1",
    });

    expect(config).toEqual({
      baseUrl: "https://example.openai.azure.com/openai/v1",
      apiVersion: "v1",
    });
    expect(testing.isOpenAICompatibleAzureResponsesBaseUrl(config.baseUrl)).toBe(false);
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://example.cognitiveservices.azure.com/openai/v1",
      ),
    ).toBe(false);
  });

  it("uses the OpenAI-compatible client path for Foundry /openai/v1 endpoints", () => {
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      ),
    ).toBe(true);
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/openai/v1",
      ),
    ).toBe(true);
  });

  it("does not treat non-v1 custom endpoints as OpenAI-compatible Responses bases", () => {
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/api/projects/demo",
      ),
    ).toBe(false);
  });
});
