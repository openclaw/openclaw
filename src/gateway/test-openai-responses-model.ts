export function buildOpenAiResponsesTestModel(id = "gpt-5.2") {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  } as const;
}

export function buildOpenAiResponsesProviderConfig(baseUrl: string, modelId = "gpt-5.2") {
  return {
    baseUrl,
    apiKey: "test",
    api: "openai-responses",
    models: [buildOpenAiResponsesTestModel(modelId)],
  } as const;
}
