#!/usr/bin/env node
/**
 * Mock MCP Server Process
 *
 * Runs as a standalone child process, speaking MCP protocol over stdio.
 * Reads configuration from MOCK_MCP_CONFIG environment variable.
 *
 * This file is spawned by mock-mcp-server.ts — not imported directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type MockToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  response?: string;
};

type MockResourceDef = {
  uri: string;
  name: string;
  description?: string;
  content: string;
  mimeType?: string;
};

type MockConfig = {
  tools?: MockToolDef[];
  resources?: MockResourceDef[];
  crashAfter?: number;
  latency?: number;
  injectPayload?: string;
};

const config: MockConfig = JSON.parse(process.env.MOCK_MCP_CONFIG ?? "{}");

const server = new McpServer(
  { name: "mock-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

let callCount = 0;

// Register tools
for (const tool of config.tools ?? []) {
  // Convert inputSchema properties to zod shape for the SDK
  // The SDK's .tool() requires a zod schema, so we build one dynamically
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    switch (prop.type) {
      case "string":
        shape[key] = z.string().optional();
        break;
      case "number":
      case "integer":
        shape[key] = z.number().optional();
        break;
      case "boolean":
        shape[key] = z.boolean().optional();
        break;
      default:
        shape[key] = z.unknown().optional();
    }
  }

  server.tool(tool.name, tool.description, shape, async (_args) => {
    callCount++;

    // Fault injection: crash after N calls
    if (config.crashAfter && callCount >= config.crashAfter) {
      process.exit(1);
    }

    // Fault injection: latency
    if (config.latency) {
      await new Promise((resolve) => setTimeout(resolve, config.latency));
    }

    // Fault injection: return injection payload
    const responseText = config.injectPayload ?? tool.response ?? `Mock response from ${tool.name}`;

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  });
}

// Register resources
for (const resource of config.resources ?? []) {
  server.resource(resource.name, resource.uri, async () => ({
    contents: [
      {
        uri: resource.uri,
        text: resource.content,
        mimeType: resource.mimeType ?? "text/plain",
      },
    ],
  }));
}

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
