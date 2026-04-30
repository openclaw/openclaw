import { describe, expect, it, vi } from "vitest";
import { buildMcpToolSchema, type McpLoopbackTool } from "./mcp-http.schema.js";

const { logWarnMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: logWarnMock,
}));

function tool(parameters: Record<string, unknown>): McpLoopbackTool {
  return {
    name: "demo",
    label: "demo",
    description: "demo tool",
    parameters,
    execute: async () => "ok",
  } as unknown as McpLoopbackTool;
}

describe("buildMcpToolSchema", () => {
  it("flattens union tool parameters without warning on repeated non-mergeable fields", () => {
    const schema = buildMcpToolSchema([
      tool({
        anyOf: [
          {
            type: "object",
            properties: {
              action: { const: "create" },
              doc_token: { type: "string", description: "Document token" },
            },
            required: ["action", "doc_token"],
          },
          {
            type: "object",
            properties: {
              action: { const: "update" },
              doc_token: { type: "string", description: "Existing document token" },
              block_id: { type: "string" },
            },
            required: ["action", "doc_token", "block_id"],
          },
        ],
      }),
    ]);

    expect(schema).toEqual([
      {
        name: "demo",
        description: "demo tool",
        inputSchema: {
          type: "object",
          properties: {
            action: { enum: ["create", "update"] },
            doc_token: { type: "string", description: "Document token" },
            block_id: { type: "string" },
          },
          required: ["action", "doc_token"],
        },
      },
    ]);
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
