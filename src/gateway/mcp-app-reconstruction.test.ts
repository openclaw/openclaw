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
        toolName: "demo__show",
        content: [
          { type: "text", text: "ok" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
        ],
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
        content: [
          { type: "text", text: "ok" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
        ],
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
            toolName: "demo__show",
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

  it("binds reused call IDs to the nearest preceding matching tool", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "shared", name: "other__tool", args: { secret: 1 } }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "shared", name: "demo__show", args: { page: 2 } }],
      },
      {
        role: "toolResult",
        toolCallId: "shared",
        toolName: "demo__show",
        content: [],
        details: {
          mcpServer: "demo",
          mcpTool: "show",
          mcpAppPreview: {
            mcpApp: {
              viewId: "mcp-app-reused",
              serverName: "demo",
              toolName: "show",
              uiResourceUri: "ui://demo/app",
              toolCallId: "shared",
            },
          },
        },
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "shared", name: "demo__show", args: { page: 3 } }],
      },
    ];

    expect(findMcpAppReconstructionData(messages, "mcp-app-reused")?.toolInput).toEqual({
      page: 2,
    });
  });

  it("declines restart reconstruction when app-only result metadata was not persisted", () => {
    expect(
      findMcpAppReconstructionData(
        [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-old", name: "demo__show", args: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call-old",
            toolName: "demo__show",
            content: [{ type: "text", text: "stale" }],
            details: {
              mcpServer: "demo",
              mcpTool: "show",
              mcpAppPreview: {
                mcpApp: {
                  viewId: "mcp-app-meta",
                  serverName: "demo",
                  toolName: "show",
                  uiResourceUri: "ui://demo/app",
                  toolCallId: "call-old",
                },
              },
            },
          },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "demo__show", args: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "demo__show",
            content: [],
            details: {
              mcpServer: "demo",
              mcpTool: "show",
              mcpAppPreview: {
                mcpApp: {
                  viewId: "mcp-app-meta",
                  serverName: "demo",
                  toolName: "show",
                  uiResourceUri: "ui://demo/app",
                  toolCallId: "call-1",
                  resultMetaState: "unavailable",
                },
              },
            },
          },
        ],
        "mcp-app-meta",
      ),
    ).toBeUndefined();
  });

  it("rejects a descriptor without its matching tool-call input", () => {
    expect(
      findMcpAppReconstructionData(
        [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "demo__show",
            content: [],
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
        content: [{ type: "toolCall", id: "call-1", name: "demo__show", args: { page: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "demo__show",
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
