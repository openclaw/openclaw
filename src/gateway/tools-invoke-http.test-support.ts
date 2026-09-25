import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect } from "vitest";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import type { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

/** Shared loopback transport with an independently reset Gateway context for each test. */
export function createToolsInvokeHttpTestServer(params: {
  handleToolsInvoke: typeof handleToolsInvokeHttpRequest;
  getPluginHandlers?: () => ReadonlyArray<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  >;
}) {
  let resolveGatewayContext: GatewayContextResolver | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (
        await params.handleToolsInvoke(req, res, {
          auth: { mode: "none", allowTailscale: false },
          resolveGatewayContext,
        })
      ) {
        return;
      }
      for (const handler of params.getPluginHandlers?.() ?? []) {
        if (await handler(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback HTTP server address");
      }
      return address.port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    resetContext() {
      const context = createGatewayRequestContext(makeContextParams());
      resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
    },
  };
}

export const postToolsInvoke = async (params: {
  port: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}) =>
  await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...params.headers },
    body: JSON.stringify(params.body),
  });

export const expectOkInvokeResponse = async (res: Response) => {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true });
  return body as { ok: boolean; result?: Record<string, unknown> };
};
