import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { GatewayMethodRegistry } from "./methods/registry.js";
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
    setMethodRegistry(this: void, registry: GatewayMethodRegistry) {
      const context = resolveGatewayContext?.();
      if (!context) {
        throw new Error("Expected initialized Gateway context");
      }
      context.getGatewayMethodRegistry = () => registry;
    },
    resetContext() {
      const context = createGatewayRequestContext(makeContextParams());
      resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
    },
  };
}

export const expectOkInvokeResponse = async (res: Response) => {
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.ok !== "boolean" ||
    (body.result !== undefined && !isRecord(body.result))
  ) {
    throw new Error("Expected an object tool response");
  }
  expect(body.ok).toBe(true);
  return { ok: body.ok, result: body.result };
};
