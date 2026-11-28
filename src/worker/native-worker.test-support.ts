import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { expect } from "vitest";
import * as httpFixture from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";

export function expectNativeRequests(
  provider: { errors: unknown[]; requests: unknown[] },
  count: number,
  expected: object,
) {
  const requests = Array.from({ length: count }, () => expected);
  expect(provider).toMatchObject({ errors: [], requests });
}

export function expectNoProxyInference(owner: {
  requests: Array<{ method: string }>;
  providerCalls: number;
}) {
  expect(owner.requests.some(({ method }) => method.startsWith("worker.inference."))).toBe(false);
  expect(owner.providerCalls).toBe(0);
}

export async function listenNativeServer(server: Server, servers: Server[]) {
  servers.push(server);
  return Number(new URL(await httpFixture.listenLoopback(server)).port);
}

export async function closeNativeServers(servers: Server[]) {
  for (const server of servers.splice(0)) {
    await httpFixture.closeHttpServer(server);
  }
}

type Reply = string | { name: string; args: object; id?: string };
type Request = Pick<IncomingMessage, "headers" | "url"> & { body: Record<string, unknown> };
export async function nativeProviderFixture(
  servers: Server[],
  model: string,
  reply: (request: number) => Reply | undefined,
  final: string,
) {
  const requests: Request[] = [];
  const errors: unknown[] = [];
  const entered = createDeferred();
  const disconnected = createDeferred();
  let held: ServerResponse | undefined;
  const send = (response: ServerResponse, value: Reply) => {
    const envelope = { id: "native", object: "chat.completion.chunk", created: 1, model };
    const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
    const frame = (delta: object, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish ? { usage } : {}),
        })}\n\n`,
      );
    const call =
      typeof value === "string"
        ? undefined
        : {
            index: 0,
            id: value.id ?? `local-${value.name}`,
            type: "function",
            function: { name: value.name, arguments: JSON.stringify(value.args) },
          };
    frame(call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: value });
    frame({}, call ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  };
  const port = await listenNativeServer(
    createServer((req, response) => {
      void (async () => {
        requests.push({ headers: req.headers, body: JSON.parse(await text(req)), url: req.url });
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
