import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createPluginToolsMcpHandlers } from "../mcp/plugin-tools-handlers.js";
import { wrapExternalContent } from "../security/external-content.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

const FULL = [...Array.from({ length: 6_000 }, (_, i) => `row ${i}`), "LAST-ROW"].join("\n");

function largeTool(text: string): AnyAgentTool {
  return {
    name: "large_report",
    label: "Large report",
    description: "Returns a large report",
    parameters: { type: "object", properties: {} } as never,
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text }], details: {} })),
  };
}

function expectBounded(text: string, full: string) {
  expect(text.length).toBeLessThan(full.length);
  expect(text).toMatch(/\[\.\.\. \d+ chars omitted\]/u);
  // MCP clients read with their own tools: no Gateway path is named.
  expect(text).not.toContain("Full output:");
}

// Both MCP serving paths forwarded tool results with no bound at all.
describe("MCP serving paths go through the one tool-result bound", () => {
  it("Gateway MCP loopback bounds an oversized result with head and tail", async () => {
    const tool = largeTool(FULL);
    const response = (await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool.name, arguments: {} },
      },
      tools: [tool],
      toolSchema: buildMcpToolSchema([tool]),
    })) as { result: { content: Array<{ type: "text"; text: string }> } };
    const text = response.result.content.map((block) => block.text).join("");
    expectBounded(text, FULL);
    expect(text).toContain("row 0\n");
    expect(text).toMatch(/LAST-ROW$/u);
  });

  it("plugin tools MCP server bounds an oversized result and keeps its wrapper closed", async () => {
    const wrapped = wrapExternalContent(FULL, { source: "api" });
    const result = await createPluginToolsMcpHandlers([largeTool(wrapped)]).callTool({
      name: "large_report",
      arguments: {},
    });
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expectBounded(text, wrapped);
    expect(text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/u);
    expect(text).toMatch(/LAST-ROW\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>$/u);
  });
});

it.each(["plain string", undefined, null, 42])(
  "keeps non-object tool results on the Gateway MCP loopback: %s",
  async (value) => {
    const tool: AnyAgentTool = {
      ...largeTool(""),
      // SAFETY: tools may return plain strings or any JSON; the handler normalizes them.
      execute: vi.fn(async () => value as never),
    };
    const response = (await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool.name, arguments: {} },
      },
      tools: [tool],
      toolSchema: buildMcpToolSchema([tool]),
    })) as { result: { isError: boolean } };
    expect(response.result.isError).toBe(false);
  },
);
