/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { VERSION } from "../version.js";

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  // Fallback: accept any object
  return { type: "object", properties: {} };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const tools = resolvePluginTools({
    context: { config: cfg },
    suppressNameConflicts: true,
  });

  if (tools.length === 0) {
    process.stderr.write("plugin-tools-serve: no plugin tools found\n");
  }

  const toolMap = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "openclaw-plugin-tools", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: resolveJsonSchemaForTool(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(
        `mcp-${Date.now()}`,
        request.params.arguments ?? {},
      );
      return {
        content: Array.isArray(result.content) ? result.content : [{ type: "text", text: String(result.content) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void server.close();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`plugin-tools-serve: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
