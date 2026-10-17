import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCliCronMcpLoopbackPreflight } from "./gateway-cli-backend.live-probe-helpers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";

const ownerToken = "test-owner-token";

function activateLoopbackRuntime(port: number): void {
  setActiveMcpLoopbackRuntime({
    port,
    ownerToken,
    nonOwnerToken: "test-non-owner-token",
  });
}

async function listen(server: Server): Promise<number> {
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
  return address.port;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function preflight(env: NodeJS.ProcessEnv = {}) {
  return verifyCliCronMcpLoopbackPreflight({ sessionKey: "session-key", env });
}

describe("gateway CLI backend live probe helpers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
  });

  it.each([false, true])(
    "checks read-only loopback discovery with automations present=%s",
    async (present) => {
      const methods: string[] = [];
      const server = createHttpServer((request, response) => {
        void (async () => {
          const body = JSON.parse(await text(request)) as {
            id?: unknown;
            method?: string;
          };
          if (body.method) {
            methods.push(body.method);
          }
          if (body.method === "notifications/initialized") {
            response.writeHead(202);
            response.end();
            return;
          }
          writeJson(response, 200, {
            jsonrpc: "2.0",
            id: body.id ?? null,
            result:
              body.method === "tools/list"
                ? {
                    tools: present
                      ? [{ name: "automations", inputSchema: { type: "object", properties: {} } }]
                      : [],
                  }
                : {},
          });
        })();
      });
      const port = await listen(server);
      activateLoopbackRuntime(port);
      try {
        const result = preflight();
        if (present) {
          await expect(result).resolves.toBeUndefined();
        } else {
          await expect(result).rejects.toThrow(
            "mcp loopback tools/list did not expose automations",
          );
        }
        expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
      } finally {
        server.close();
      }
    },
  );

  it("bounds loopback JSON-RPC calls when the server accepts connections but never responds", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {});
    });
    const port = await listen(server);
    activateLoopbackRuntime(port);
    const startedAt = Date.now();
    try {
      await expect(preflight({ OPENCLAW_MCP_LOOPBACK_PROBE_TIMEOUT_MS: "100" })).rejects.toThrow(
        /aborted|AbortError/iu,
      );
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });

  it("caps loopback JSON-RPC response bodies", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(256));
    });
    const port = await listen(server);
    activateLoopbackRuntime(port);
    try {
      await expect(preflight({ OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" })).rejects.toThrow(
        "mcp loopback response body exceeded 64 bytes",
      );
    } finally {
      server.close();
    }
  });

  it("preserves the byte-limit diagnostic when body cancellation rejects", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("loopback body cancellation failed");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    activateLoopbackRuntime(12345);
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
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("loopback response read failed"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    activateLoopbackRuntime(12345);

    await expect(preflight()).rejects.toThrow("loopback response read failed");
    expect(body.locked).toBe(false);
  });
});
