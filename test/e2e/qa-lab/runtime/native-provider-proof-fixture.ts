import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ModelDefinitionConfig } from "../../../../src/config/types.models.js";

export function createNativeProvider(
  handle: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<void>,
  onError: (error: unknown, response: ServerResponse) => void,
) {
  return createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      await handle(request, response, Buffer.concat(chunks).toString());
    })().catch((error: unknown) => onError(error, response));
  });
}

export async function listenNativeProvider(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("provider listener unavailable");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

export async function closeNativeProvider(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function writeNativeCompletion(
  response: ServerResponse,
  id: string,
  model: string,
  delta: Record<string, unknown> | string,
  finish = "stop",
) {
  const content = typeof delta === "string" ? { role: "assistant", content: delta } : delta;
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [part, finish_reason] of [
    [content, null],
    [{}, finish],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: part, finish_reason }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

export function nativeModel(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow: 32768,
    maxTokens: 1024,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}
