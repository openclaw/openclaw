/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { routeLogsToStderr } from "../logging/console.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { VERSION } from "../version.js";
import { resolvePluginResources, type McpResourceDefinition } from "./plugin-resources.js";

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  // Fallback: accept any object
  return { type: "object", properties: {} };
}

function resolveTools(config: OpenClawConfig): AnyAgentTool[] {
  return resolvePluginTools({
    context: { config },
    suppressNameConflicts: true,
  });
}

export function createPluginToolsMcpServer(
  params: {
    config?: OpenClawConfig;
    tools?: AnyAgentTool[];
    resources?: McpResourceDefinition[];
  } = {},
): Server {
  const cfg = params.config ?? loadConfig();
  const tools = params.tools ?? resolveTools(cfg);
  const resources =
    params.resources ?? resolvePluginResources({ config: cfg, tools });

  const toolMap = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  const resourceMap = new Map<string, McpResourceDefinition>();
  for (const resource of resources) {
    resourceMap.set(resource.uri, resource);
  }

  const server = new Server(
    { name: "openclaw-plugin-tools", version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
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
      const result = await tool.execute(`mcp-${Date.now()}`, request.params.arguments ?? {});
      return {
        content: Array.isArray(result.content)
          ? result.content
          : [{ type: "text", text: String(result.content) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resourceMap.get(request.params.uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.read(),
        },
      ],
    };
  });

  return server;
}

export async function servePluginToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only.
  routeLogsToStderr();

  const config = loadConfig();
  const tools = resolveTools(config);
  const resources = resolvePluginResources({ config, tools });
  const server = createPluginToolsMcpServer({ config, tools, resources });
  if (tools.length === 0) {
    process.stderr.write("plugin-tools-serve: no plugin tools found\n");
  }
  if (resources.length > 0) {
    process.stderr.write(`plugin-tools-serve: ${resources.length} resources available\n`);
  }

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  servePluginToolsMcp().catch((err) => {
    process.stderr.write(
      `plugin-tools-serve: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
