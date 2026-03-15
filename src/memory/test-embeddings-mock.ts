export function createOpenAIEmbeddingProviderMock(params: {
  embedQuery: (input: string) => Promise<number[]>;
  embedBatch: (input: string[]) => Promise<number[][]>;
}) {
  return {
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: params.embedQuery,
      embedBatch: params.embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  };
}
