import http from "node:http";
import { text } from "node:stream/consumers";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";

/** A real MCP transport whose expired session keeps replacement initialization pending. */
export async function startPromptCacheMcpServer(signal: AbortSignal) {
  const reconnectStarted = createDeferred();
  const reconnectReleased = createDeferred();
  const reconnectListed = createDeferred();
  let generation = 0;
  let activeSessionId: string | undefined;
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      http.createServer((request, response) => {
        const finish = (status: number, body?: string) => {
          response.writeHead(status).end(body);
        };
        if (request.method !== "POST") {
          return finish(request.method === "DELETE" ? 204 : 405);
        }
        const respond = async () => {
          const message = JSON.parse(await text(request)) as {
            id?: number | string;
            method: string;
            params?: { protocolVersion?: string };
          };
          const reply = (result: unknown) => {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          };
          if (message.method === "initialize") {
            generation++;
            if (generation > 1) {
              reconnectStarted.resolve();
              await reconnectReleased.promise;
            }
            activeSessionId = `cache-mcp-${generation}`;
            response.setHeader("mcp-session-id", activeSessionId);
            return reply({
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "cache-fixture", version: "1" },
            });
          }
          if (request.headers["mcp-session-id"] !== activeSessionId || !activeSessionId) {
            return finish(404, "Session not found");
          }
          if (message.method === "notifications/initialized") {
            finish(202);
          } else if (message.method === "tools/list") {
            reply({
              tools: [
                {
                  name: "probe",
                  description: "Read the synthetic prompt-cache fixture.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            });
            if (generation > 1) {
              reconnectListed.resolve();
            }
          } else if (message.method === "tools/call") {
            reply({ content: [{ type: "text", text: "synthetic MCP result" }] });
          } else {
            finish(405);
          }
        };
        void respond().catch(() => finish(500, "Invalid synthetic MCP request"));
      }),
  });
  return {
    config: {
      servers: {
        cache_fixture: {
          url: `http://127.0.0.1:${reservation.claim.port}/mcp`,
          transport: "streamable-http",
        },
      },
    } satisfies NonNullable<OpenClawConfig["mcp"]>,
    expireSession() {
      activeSessionId = undefined;
    },
    reconnectStarted: reconnectStarted.promise,
    reconnectListed: reconnectListed.promise,
    releaseReconnect: reconnectReleased.resolve,
    async close() {
      reconnectReleased.resolve();
      reservation.listener.closeAllConnections();
      try {
        await reservation.releaseListener();
      } finally {
        await reservation.claim.release();
      }
    },
  };
}
