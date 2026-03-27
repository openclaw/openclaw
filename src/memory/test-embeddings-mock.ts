import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

export function createOpenAIEmbeddingProviderMock(params: {
  embedQuery: (input: string) => Promise<number[]>;
  embedBatch: (input: string[]) => Promise<number[][]>;
}) {
  const baseUrl = "https://api.openai.com/v1";
  return {
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: params.embedQuery,
      embedBatch: params.embedBatch,
    },
    openAi: {
      baseUrl,
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
      model: "text-embedding-3-small",
    },
  };
}
