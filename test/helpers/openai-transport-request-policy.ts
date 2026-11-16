import { createServer } from "node:http";
import type { Model, StreamFn } from "@openclaw/ai";
import { expect } from "vitest";

// Loaded hosted runners can delay the first real loopback request beyond the shared timeout.
export const COLD_RUNNER_HTTP_TEST_TIMEOUT_MS = 300_000;

export async function expectOpenAITransportRequestPolicy(transport: {
  api: Model["api"];
  provider: string;
  createStream: () => StreamFn;
}): Promise<void> {
  const capturedTimeouts: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const timeout = request.headers["x-stainless-timeout"];
    capturedTimeouts.push(Array.isArray(timeout) ? timeout[0] : timeout);
    request.resume();
    request.on("end", () => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "server_error", message: "turn retry regression" },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }

    const model = {
      id: "test-model",
      name: "Test Model",
      api: transport.api,
      provider: transport.provider,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
      requestTimeoutMs: 900_000,
    } satisfies Model & { requestTimeoutMs: number };

    const stream = await transport.createStream()(
      model,
      {
        messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
        tools: [],
      },
      { apiKey: "test-key", timeoutMs: 1_234 },
    );

    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toContain("error");
    // The SDK advertises request timeouts in whole seconds on the wire.
    expect(capturedTimeouts).toEqual(["1"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
