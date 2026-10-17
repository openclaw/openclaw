import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { text } from "node:stream/consumers";
import { expect } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

export function expectNativeRequests(
  provider: { errors: unknown[]; requests: unknown[] },
  count: number,
  expected: object,
) {
  expect(provider.errors).toEqual([]);
  expect(provider.requests).toHaveLength(count);
  for (const request of provider.requests) {
    expect(request).toMatchObject(expected);
  }
}

export function expectNoProxyInference(owner: {
  requests: Array<{ method: string }>;
  providerCalls: number;
}) {
  expect(
    owner.requests.filter((request) => request.method.startsWith("worker.inference.")),
  ).toEqual([]);
  expect(owner.providerCalls).toBe(0);
}

export async function listenNativeServer(server: Server, servers: Server[]) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP fixture");
  }
  return address.port;
}

export async function closeNativeServers(servers: Server[]) {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

type Reply = string | { name: string; args: object; id?: string };
export async function nativeProviderFixture(
  servers: Server[],
  model: string,
  reply: (request: number) => Reply | undefined,
  final: string,
) {
  const requests: Array<{
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
    url?: string;
  }> = [];
  const errors: unknown[] = [];
  const entered = createDeferred();
  const disconnected = createDeferred();
  let held: ServerResponse | undefined;
  const send = (response: ServerResponse, value: Reply) => {
    const frame = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "native-response",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
            : {}),
        })}\n\n`,
      );
    frame(
      typeof value === "string"
        ? { role: "assistant", content: value }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: value.id ?? `local-${value.name}`,
                type: "function",
                function: { name: value.name, arguments: JSON.stringify(value.args) },
              },
            ],
          },
    );
    frame({}, typeof value === "string" ? "stop" : "tool_calls");
    response.end("data: [DONE]\n\n");
  };
  const port = await listenNativeServer(
    createServer((request, response) => {
      void (async () => {
        requests.push({
          headers: request.headers,
          body: JSON.parse(await text(request)),
          url: request.url,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const value = reply(requests.length);
        if (value === undefined) {
          held = response;
          response.flushHeaders();
          response.once("close", () => disconnected.resolve());
        } else {
          send(response, value);
        }
        entered.resolve();
      })().catch((error: unknown) => {
        errors.push(error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }),
    servers,
  );
  return {
    requests,
    errors,
    entered: entered.promise,
    disconnected: disconnected.promise,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    release: () => {
      if (held && !held.destroyed) {
        send(held, final);
      }
    },
  };
}
