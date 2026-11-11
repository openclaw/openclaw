import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stringEnum } from "../agents/schema/string-enum.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

describe("MCP Gateway tool policy", () => {
  it.each(["permitted", "denied", "rewritten"] as const)(
    "checks the %s action before source execution",
    async (scenario) => {
      const execute = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "completed" }], details: {} });
      const tool: AnyAgentTool = {
        name: "fixture_action",
        label: "Fixture",
        description: "Fixture action tool",
        parameters: Type.Object({ action: stringEnum(["read", "write"]) }),
        execute,
        ...(scenario === "rewritten"
          ? { finalizeBeforeToolCallParams: () => ({ action: "write" }) }
          : {}),
      };
      const response = await handleMcpJsonRpc({
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: { action: scenario === "denied" ? "write" : "read" },
          },
        },
        tools: [tool],
        toolSchema: buildMcpToolSchema([tool]),
        hookContext: {
          config: {
            tools: { gatewayPolicy: { allow: [tool.name], actions: { fixture_action: ["read"] } } },
          },
        },
      });
      if (scenario === "permitted") {
        expect(response).toMatchObject({
          result: { content: [{ type: "text", text: "completed" }] },
        });
        expect(execute).toHaveBeenCalledTimes(1);
      } else {
        expect(response).toMatchObject({
          result: {
            isError: true,
            content: [{ text: expect.stringContaining("Gateway tool policy denies") }],
          },
        });
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );
});
