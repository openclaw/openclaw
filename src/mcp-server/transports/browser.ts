/**
 * MCP Browser Transport
 *
 * WebSocket-based transport for browser clients.
 * Enables MCP communication from web applications and browser extensions.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { McpMessage, McpTransport } from "../types.js";

export interface BrowserTransportOptions {
  port: number;
  host?: string;
  cors?: {
    origin?: string | string[];
    credentials?: boolean;
  };
}

interface BrowserClient {
  ws: WebSocket;
  id: string;
}

export function createBrowserTransport(options: BrowserTransportOptions): McpTransport {
  let messageHandler: ((message: McpMessage) => Promise<McpMessage | void>) | null = null;
  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Map<string, BrowserClient>();
  let clientIdCounter = 0;

  function generateClientId(): string {
    return `browser-${++clientIdCounter}-${Date.now()}`;
  }

  function validateOrigin(origin: string | undefined): boolean {
    if (!options.cors?.origin) {
      // Default: allow localhost origins for development
      if (!origin) return true;
      return (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.startsWith("https://localhost") ||
        origin.startsWith("https://127.0.0.1")
      );
    }

    if (typeof options.cors.origin === "string") {
      return options.cors.origin === "*" || origin === options.cors.origin;
    }

    return options.cors.origin.includes(origin ?? "");
  }

  const transport: McpTransport = {
    onMessage(handler) {
      messageHandler = handler;
    },

    async send(message) {
      const data = JSON.stringify(message);
      for (const client of clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data);
        }
      }
    },

    async close() {
      for (const client of clients.values()) {
        client.ws.close();
      }
      clients.clear();

      if (wss) {
        wss.close();
        wss = null;
      }

      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }
    },

    async start() {
      httpServer = createServer((req, res) => {
        // Handle CORS preflight
        const origin = req.headers.origin;
        if (validateOrigin(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
          if (options.cors?.credentials) {
            res.setHeader("Access-Control-Allow-Credentials", "true");
          }
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Health check endpoint
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", clients: clients.size }));
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      });

      wss = new WebSocketServer({ server: httpServer });

      wss.on("connection", (ws, req) => {
        const origin = req.headers.origin;
        if (!validateOrigin(origin)) {
          console.error(`[mcp-browser] Rejected connection from origin: ${origin}`);
          ws.close(4003, "Origin not allowed");
          return;
        }

        const clientId = generateClientId();
        const client: BrowserClient = { ws, id: clientId };
        clients.set(clientId, client);

        console.error(`[mcp-browser] Client connected: ${clientId}`);

        ws.on("message", async (data) => {
          if (!messageHandler) return;

          try {
            const message = JSON.parse(data.toString()) as McpMessage;
            const response = await messageHandler(message);
            if (response) {
              ws.send(JSON.stringify(response));
            }
          } catch (err) {
            console.error(`[mcp-browser] Message error: ${String(err)}`);
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: "Parse error" },
              }),
            );
          }
        });

        ws.on("close", () => {
          clients.delete(clientId);
          console.error(`[mcp-browser] Client disconnected: ${clientId}`);
        });

        ws.on("error", (err) => {
          console.error(`[mcp-browser] WebSocket error: ${String(err)}`);
          clients.delete(clientId);
        });
      });

      const host = options.host ?? "127.0.0.1";
      return new Promise<void>((resolve, reject) => {
        httpServer!.listen(options.port, host, () => {
          console.error(`[mcp-browser] WebSocket server listening on ws://${host}:${options.port}`);
          resolve();
        });
        httpServer!.on("error", reject);
      });
    },
  };

  return transport;
}
