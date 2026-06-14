import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

function createToolWithUnreadableField(field: "name" | "parameters") {
  const tool = {
    name: "poisoned_tool",
    description: "Poisoned tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  };
  Object.defineProperty(tool, field, {
    enumerable: true,
    get() {
      throw new Error(`${field} revoked`);
    },
  });
  return tool as never;
}

function createToolWithPoisonedExecuteBind() {
  const execute = vi.fn().mockResolvedValue({ content: "Poisoned execute still callable." });
  Object.defineProperty(execute, "bind", {
    get() {
      throw new Error("bind revoked");
    },
  });
  return {
    name: "poisoned_bind",
    description: "Poisoned bind",
    parameters: { type: "object", properties: {} },
    execute,
  } as unknown as AnyAgentTool;
}

describe("createPluginToolsMcpHandlers", () => {
  it("isolates unreadable plugin tool metadata on the MCP bridge", async () => {
    const execute = vi.fn().mockResolvedValue({ content: "Stored." });
    const healthyTool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([
      createToolWithUnreadableField("parameters"),
      healthyTool,
    ]);

    await expect(handlers.listTools()).resolves.toEqual({
      tools: [
        {
          name: "memory_recall",
          description: "Recall stored memory",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      ],
    });

    const result = await handlers.callTool({
      name: "memory_recall",
      arguments: { query: "remember this" },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
  });

  it("does not read plugin execute bind while snapshotting MCP tools", async () => {
    const handlers = createPluginToolsMcpHandlers([createToolWithPoisonedExecuteBind()]);

    await expect(handlers.listTools()).resolves.toEqual({
      tools: [
        {
          name: "poisoned_bind",
          description: "Poisoned bind",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    await expect(
      handlers.callTool({
        name: "poisoned_bind",
        arguments: {},
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Poisoned execute still callable." }],
    });
  });
});
