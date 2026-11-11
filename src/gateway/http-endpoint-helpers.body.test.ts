import { createServer } from "node:http";
import { duplexPair } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sendJson, readJsonBodyOrError } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("node:timers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers")>()),
  setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeGatewayHttpRequestOrReply: vi.fn(async () => ({
    trustDeclaredOperatorScopes: true,
    hasCurrentClientAuthority: () => true,
    assertCurrent: () => {},
    revalidate: async () => {},
  })),
  resolveSharedSecretHttpOperatorScopes: () => ["operator.write"],
}));

afterEach(() => vi.useRealTimers());

describe("HTTP upload deadlines", () => {
  it.each([
    { endpoint: "compat", elapsedMs: 45_000, expectedStatus: 200 },
    { endpoint: "compat", elapsedMs: 60_001, expectedStatus: 408 },
    { endpoint: "webhook default", elapsedMs: 30_001, expectedStatus: 408 },
  ])(
    "$endpoint upload after $elapsedMs ms returns $expectedStatus",
    async ({ endpoint, elapsedMs, expectedStatus }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const received = createDeferred();
      const [client, socket] = duplexPair();
      const chunks: Buffer[] = [];
      client.on("data", (chunk: Buffer) => chunks.push(chunk));
      const response = new Promise<void>((resolve) => {
        client.once("end", resolve);
      });
      let task: Promise<void> | undefined;
      const server = createServer((req, res) => {
        task = (async () => {
          received.resolve();
          const handled =
            endpoint === "compat"
              ? await handleGatewayPostJsonEndpoint(req, res, {
                  pathname: "/v1/chat/completions",
                  auth: { mode: "none", allowTailscale: false },
                  requiredOperatorMethod: "chat.send",
                  maxBodyBytes: 1024,
                })
              : { body: await readJsonBodyOrError(req, res, 1024) };
          if (handled && handled.body !== undefined) {
            sendJson(res, 200, handled.body);
          }
        })();
      });
      server.emit("connection", socket);
      try {
        client.write(
          "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 16\r\n\r\n",
        );
        await received.promise;
        await vi.advanceTimersByTimeAsync(0);
        client.write('{"message":');
        await vi.advanceTimersByTimeAsync(elapsedMs);
        if (expectedStatus === 200) {
          client.write('"ok"}');
        }
        await response;
        const wire = Buffer.concat(chunks).toString();
        expect(wire).toContain(`HTTP/1.1 ${expectedStatus} `);
        expect(wire).toContain(
          expectedStatus === 200
            ? '{"message":"ok"}'
            : '{"error":{"message":"Request body timeout","type":"invalid_request_error"}}',
        );
      } finally {
        client.destroy();
        socket.destroy();
        server.close();
        await task;
      }
    },
  );
});
