#!/usr/bin/env node
/**
 * AgentGlob Rain MCP server.
 *
 * Exposes Rain prediction-market capabilities as typed MCP tools backed by
 * the dashboard's /api/runtime/rain/* endpoints. Wraps the HTTP contract
 * documented in openclaw-dashboard/docs/api/rain-runtime.md.
 *
 * V1.5 scope: read + build only (rain_list_markets, rain_get_market,
 * rain_build_buy, rain_build_claim). No composite execute tools — see
 * RAIN_V2_ARCHITECTURE.md §14.6.
 *
 * Runs as a stdio MCP server, intended to be spawned by the openclaw
 * gateway as a child process. Inherits AGENTGLOB_RUNTIME_URL and
 * AGENTGLOB_RUNTIME_TOKEN from the gateway's process env.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RainRuntimeClient, RuntimeClientError } from "./runtime-client.js";
import { RAIN_TOOLS } from "./tools.js";

async function main(): Promise<void> {
  // Validate env up-front so a missing-env failure surfaces clearly during
  // MCP startup rather than on first tool call.
  let client: RainRuntimeClient;
  try {
    client = RainRuntimeClient.fromEnv();
  } catch (err) {
    if (err instanceof RuntimeClientError) {
      console.error(`[rain-mcp] startup error: ${err.message}`);
    } else {
      console.error(`[rain-mcp] startup error: ${String(err)}`);
    }
    process.exit(1);
  }

  const server = new Server(
    { name: "agentglob-rain", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RAIN_TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = RAIN_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const args = req.params.arguments ?? {};
      const result = await tool.handler(client, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof RuntimeClientError) {
        const codeTag = err.code ? ` (code=${err.code})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Rain runtime error ${err.status}${codeTag}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Internal MCP error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Transport keeps the process alive on stdio.
}

main().catch((err) => {
  console.error("[rain-mcp] fatal:", err);
  process.exit(1);
});
