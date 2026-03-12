/**
 * MCP Stdio Transport
 *
 * Standard input/output transport for MCP server communication.
 * Used by Claude Code and other CLI-based MCP clients.
 */

import * as readline from "node:readline";
import type { McpMessage, McpTransport } from "../types.js";

export function createStdioTransport(): McpTransport {
  let messageHandler: ((message: McpMessage) => Promise<McpMessage | void>) | null = null;
  let rl: readline.Interface | null = null;

  const transport: McpTransport = {
    onMessage(handler) {
      messageHandler = handler;
    },

    async send(message) {
      const line = JSON.stringify(message);
      process.stdout.write(line + "\n");
    },

    async close() {
      if (rl) {
        rl.close();
        rl = null;
      }
    },

    async start() {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      rl.on("line", async (line) => {
        if (!messageHandler || !line.trim()) {
          return;
        }

        try {
          const message = JSON.parse(line) as McpMessage;
          const response = await messageHandler(message);
          if (response) {
            await transport.send(response);
          }
        } catch (err) {
          console.error(`[mcp-stdio] Parse error: ${String(err)}`);
        }
      });

      rl.on("close", () => {
        process.exit(0);
      });
    },
  };

  return transport;
}
