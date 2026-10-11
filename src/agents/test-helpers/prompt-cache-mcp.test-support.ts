import http from "node:http";
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
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const respond = async () => {
            const message = JSON.parse(body) as {
              id?: number | string;
              method: string;
              params?: { protocolVersion?: string };
            };
            const reply = (result: unknown) => {
              response.setHeader("content-type", "application/json");
              response
                .writeHead(200)
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
              reply({
                protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "cache-fixture", version: "1" },
              });
              return;
            }
            if (request.headers["mcp-session-id"] !== activeSessionId || !activeSessionId) {
              response.writeHead(404).end("Session not found");
              return;
            }
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
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
              response.writeHead(405).end();
            }
          };
          void respond().catch(() => {
            response.writeHead(500).end("Invalid synthetic MCP request");
          });
        });
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
    releaseReconnect() {
      reconnectReleased.resolve();
    },
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
