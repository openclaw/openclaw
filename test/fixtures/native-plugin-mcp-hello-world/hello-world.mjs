#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "hello-world-mcp",
  version: "1.0.0",
});

server.tool("hello_world", "Return a fixed greeting for MCP proofing.", async () => {
  return {
    content: [
      {
        type: "text",
        text: process.env.HELLO_WORLD_TEXT ?? "hi human",
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
