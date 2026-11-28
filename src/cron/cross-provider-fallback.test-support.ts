import http from "node:http";

/** Loopback OpenAI-Responses providers for scheduled cross-provider fallback tests. */

export const QUOTA_EXHAUSTED_BODY = JSON.stringify({
  error: {
    message: "You exceeded your current quota, please check your plan and billing.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
});

export function completedSse(model: string, text: string): string {
  const item = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = { id: "resp_synthetic", model, status: "in_progress", output: [] };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

export async function listenLoopbackProvider(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback TCP server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function loopbackProviderConfig(baseUrl: string) {
  return {
    api: "openai-responses" as const,
    baseUrl,
    agentRuntime: { id: "openclaw" },
    models: [
      {
        id: "gpt-4.1",
        name: "gpt-4.1",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    ],
  };
}

export const loopbackModelRuntime = {
  agentRuntime: { id: "openclaw" },
  params: { transport: "sse" },
};

export function apiKeyProfile(profileId: string, key: string) {
  return {
    profileId,
    credential: {
      type: "api_key" as const,
      provider: profileId.slice(0, profileId.indexOf(":")),
      key,
    },
  };
}
