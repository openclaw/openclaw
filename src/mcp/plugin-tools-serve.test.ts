import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { McpResourceDefinition } from "./plugin-resources.js";
import { createPluginToolsMcpServer } from "./plugin-tools-serve.js";

async function connectPluginToolsServer(
  tools: AnyAgentTool[],
  resources?: McpResourceDefinition[],
) {
  const server = createPluginToolsMcpServer({ tools, resources });
  const client = new Client({ name: "plugin-tools-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin tools MCP server", () => {
  it("lists registered plugin tools with their input schema", async () => {
    const tool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute: vi.fn(),
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([tool]);
    try {
      const listed = await session.client.listTools();
      expect(listed.tools).toEqual([
        expect.objectContaining({
          name: "memory_recall",
          description: "Recall stored memory",
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["query"],
          }),
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  it("serializes non-array tool content as text for MCP callers", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([tool]);
    try {
      const result = await session.client.callTool({
        name: "memory_store",
        arguments: { text: "remember this" },
      });
      expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^mcp-\d+$/), {
        text: "remember this",
      });
      expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
    } finally {
      await session.close();
    }
  });

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      name: "memory_forget",
      description: "Forget memory",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([failingTool]);
    try {
      const unknown = await session.client.callTool({
        name: "missing_tool",
        arguments: {},
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([{ type: "text", text: "Unknown tool: missing_tool" }]);

      const failed = await session.client.callTool({
        name: "memory_forget",
        arguments: {},
      });
      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([{ type: "text", text: "Tool error: boom" }]);
    } finally {
      await session.close();
    }
  });

  describe("resources", () => {
    it("lists registered resources", async () => {
      const resources: McpResourceDefinition[] = [
        {
          uri: "openclaw://test/hello",
          name: "Hello Resource",
          description: "A test resource",
          mimeType: "text/plain",
          read: () => "hello world",
        },
      ];
      const session = await connectPluginToolsServer([], resources);
      try {
        const listed = await session.client.listResources();
        expect(listed.resources).toEqual([
          expect.objectContaining({
            uri: "openclaw://test/hello",
            name: "Hello Resource",
            description: "A test resource",
            mimeType: "text/plain",
          }),
        ]);
      } finally {
        await session.close();
      }
    });

    it("reads a registered resource", async () => {
      const resources: McpResourceDefinition[] = [
        {
          uri: "openclaw://test/data",
          name: "Test Data",
          description: "Returns JSON data",
          mimeType: "application/json",
          read: () => JSON.stringify({ status: "ok" }),
        },
      ];
      const session = await connectPluginToolsServer([], resources);
      try {
        const result = await session.client.readResource({ uri: "openclaw://test/data" });
        expect(result.contents).toEqual([
          expect.objectContaining({
            uri: "openclaw://test/data",
            mimeType: "application/json",
            text: JSON.stringify({ status: "ok" }),
          }),
        ]);
      } finally {
        await session.close();
      }
    });

    it("throws for unknown resource URI", async () => {
      const session = await connectPluginToolsServer([], []);
      try {
        await expect(
          session.client.readResource({ uri: "openclaw://nonexistent" }),
        ).rejects.toThrow();
      } finally {
        await session.close();
      }
    });

    it("exposes built-in resources when none are explicitly provided", async () => {
      const tool = {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      } as unknown as AnyAgentTool;

      const session = await connectPluginToolsServer([tool]);
      try {
        const listed = await session.client.listResources();
        expect(listed.resources.length).toBeGreaterThanOrEqual(1);
        const uris = listed.resources.map((r) => r.uri);
        expect(uris).toContain("openclaw://version");
        expect(uris).toContain("openclaw://tools");
      } finally {
        await session.close();
      }
    });
  });
});
