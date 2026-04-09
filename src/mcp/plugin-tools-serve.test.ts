import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginToolsMcpServer } from "./plugin-tools-serve.js";

async function connectPluginToolsServer(tools: AnyAgentTool[], config?: OpenClawConfig) {
  const server = createPluginToolsMcpServer({ tools, config });
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
});

describe("security boundary — tool deny list", () => {
  function makeTool(name: string): AnyAgentTool {
    return {
      name,
      description: `Test tool: ${name}`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({ content: `${name} executed` }),
    } as unknown as AnyAgentTool;
  }

  it("excludes default-denied tools from listTools response", async () => {
    const safeTool = makeTool("memory_recall");
    const deniedTool = makeTool("exec");
    const session = await connectPluginToolsServer([safeTool, deniedTool], {} as OpenClawConfig);
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).toContain("memory_recall");
      expect(names).not.toContain("exec");
    } finally {
      await session.close();
    }
  });

  it("rejects callTool for a denied tool without executing it", async () => {
    const deniedTool = makeTool("exec");
    const session = await connectPluginToolsServer([deniedTool], {} as OpenClawConfig);
    try {
      const result = await session.client.callTool({ name: "exec", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Tool denied by security policy: exec" },
      ]);
      expect(deniedTool.execute).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("re-enables a denied tool when operator config allows it", async () => {
    const execTool = makeTool("exec");
    const config = { gateway: { tools: { allow: ["exec"] } } } as OpenClawConfig;
    const session = await connectPluginToolsServer([execTool], config);
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain("exec");
      const result = await session.client.callTool({ name: "exec", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(execTool.execute).toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("blocks an additional tool when operator config denies it", async () => {
    const customTool = makeTool("custom_dangerous");
    const config = { gateway: { tools: { deny: ["custom_dangerous"] } } } as OpenClawConfig;
    const session = await connectPluginToolsServer([customTool], config);
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((t) => t.name)).not.toContain("custom_dangerous");
      const result = await session.client.callTool({ name: "custom_dangerous", arguments: {} });
      expect(result.isError).toBe(true);
      expect(customTool.execute).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
