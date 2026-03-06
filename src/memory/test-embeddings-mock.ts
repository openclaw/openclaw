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
      // Tests stub global fetch and do not hit the network. In CI/dev sandboxes
      // DNS can resolve public hosts to special-use ranges, which trips SSRF guard.
      // Allow private-network resolution for this test helper so mocked fetch can run.
      ssrfPolicy: {
        allowedHostnames: ["api.openai.com"],
        dangerouslyAllowPrivateNetwork: true,
      },
    },
  };
}
