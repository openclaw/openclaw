import { describe, expect, it } from "vitest";
import {
  findMcpAppReconstructionData,
  findMcpAppReconstructionDataByVisit,
} from "./mcp-app-reconstruction.js";

describe("MCP App transcript reconstruction", () => {
  it("reconstructs only a descriptor bound to its tool call and result", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "demo__show",
            arguments: { city: "Paris" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "ok" }],
        details: {
          mcpServer: "demo",
          mcpTool: "show",
          structuredContent: { city: "Paris" },
          mcpAppPreview: {
            kind: "canvas",
            view: { id: "mcp-app-1" },
            mcpApp: {
              viewId: "mcp-app-1",
              serverName: "demo",
              toolName: "show",
              uiResourceUri: "ui://demo/app",
              toolCallId: "call-1",
            },
          },
        },
      },
    ];

    expect(findMcpAppReconstructionData(messages, "mcp-app-1")).toEqual({
      descriptor: {
        viewId: "mcp-app-1",
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app",
        toolCallId: "call-1",
      },
      toolInput: { city: "Paris" },
      toolResult: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { city: "Paris" },
      },
    });
  });

  it("rejects client-selected descriptors that do not match transcript ownership", () => {
    expect(
      findMcpAppReconstructionData(
        [
          {
            role: "toolResult",
            toolCallId: "call-other",
            details: {
              mcpServer: "demo",
              mcpTool: "show",
              mcpAppPreview: {
                mcpApp: {
                  viewId: "mcp-app-1",
                  serverName: "demo",
                  toolName: "show",
                  uiResourceUri: "ui://demo/app",
                  toolCallId: "call-1",
                },
              },
            },
          },
        ],
        "mcp-app-1",
      ),
    ).toBeUndefined();
  });

  it("streams the full active transcript instead of limiting reconstruction to its tail", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", args: { page: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "ok" }],
        details: {
          mcpServer: "demo",
          mcpTool: "show",
          mcpAppPreview: {
            mcpApp: {
              viewId: "mcp-app-1",
              serverName: "demo",
              toolName: "show",
              uiResourceUri: "ui://demo/app",
              toolCallId: "call-1",
            },
          },
        },
      },
      ...Array.from({ length: 2_500 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `later-${index}` }],
      })),
    ];
    let passes = 0;
    const result = await findMcpAppReconstructionDataByVisit(async (visit) => {
      passes += 1;
      for (const message of messages) {
        visit(message);
      }
    }, "mcp-app-1");

    expect(passes).toBe(2);
    expect(result?.toolInput).toEqual({ page: 1 });
  });
});
