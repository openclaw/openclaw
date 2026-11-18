import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCliCronMcpLoopbackPreflight } from "./gateway-cli-backend.live-probe-helpers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";

const ownerToken = "test-owner-token";
type RpcMessage = { id?: unknown; method?: string };

function activateLoopbackRuntime(port: number): void {
  setActiveMcpLoopbackRuntime({
    port,
    ownerToken,
    nonOwnerToken: "test-non-owner-token",
  });
}

const servers = new Set<Server>();
async function activateServer(server: Server): Promise<void> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  activateLoopbackRuntime(address.port);
}

function mockResponse(source: UnderlyingDefaultSource<Uint8Array>) {
  const body = new ReadableStream<Uint8Array>(source);
  const fetch = vi.fn(async () => new Response(body));
  vi.stubGlobal("fetch", fetch);
  activateLoopbackRuntime(12345);
  return body;
}

function preflight(env: NodeJS.ProcessEnv = {}) {
  return verifyCliCronMcpLoopbackPreflight({ sessionKey: "session-key", env });
}

describe("gateway CLI backend live probe helpers", () => {
  beforeEach(() => vi.useRealTimers());

  afterEach(() => {
    vi.unstubAllGlobals();
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
    servers.forEach((server) => server.close());
    servers.clear();
  });

  it.each([false, true])(
    "checks read-only loopback discovery with automations present=%s",
    async (present) => {
      const methods: string[] = [];
      const tools = present
        ? [{ name: "automations", inputSchema: { type: "object", properties: {} } }]
        : [];
      await activateServer(
        createHttpServer((request, response) => {
          void (async () => {
            const body = JSON.parse(await text(request)) as RpcMessage;
            if (body.method) {
              methods.push(body.method);
            }
            if (body.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? null,
                result: body.method === "tools/list" ? { tools } : {},
              }),
            );
          })();
        }),
      );
      const result = preflight();
      if (present) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow("mcp loopback tools/list did not expose automations");
      }
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    },
  );

  it("bounds loopback JSON-RPC calls when the server accepts connections but never responds", async () => {
    const sockets = new Set<Socket>();
    await activateServer(
      createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", () => {});
      }),
    );
    const startedAt = Date.now();
    try {
      await expect(preflight({ OPENCLAW_MCP_LOOPBACK_PROBE_TIMEOUT_MS: "100" })).rejects.toThrow(
        /aborted|AbortError/iu,
      );
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      sockets.forEach((socket) => socket.destroy());
    }
  });

  it("caps loopback JSON-RPC response bodies", async () => {
    await activateServer(
      createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("x".repeat(256));
      }),
    );
    await expect(preflight({ OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" })).rejects.toThrow(
      "mcp loopback response body exceeded 64 bytes",
    );
  });

  it("preserves the byte-limit diagnostic when body cancellation rejects", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    const cancel = vi.fn(() => {
      throw new Error("loopback body cancellation failed");
    });
    const body = mockResponse({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel,
    });
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(preflight({ OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" })).rejects.toThrow(
        "mcp loopback response body exceeded 64 bytes",
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it("still propagates loopback response read errors and releases the reader lock", async () => {
    const body = mockResponse({
      start(controller) {
        controller.error(new Error("loopback response read failed"));
      },
    });

    await expect(preflight()).rejects.toThrow("loopback response read failed");
    expect(body.locked).toBe(false);
  });
});
