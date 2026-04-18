/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { buildChatItems } from "./build-chat-items.ts";

vi.mock("../components/mcp-app-view.ts", () => ({}));

describe("buildChatItems", () => {
  it("upgrades assistant embed shortcodes with MCP App metadata from persisted tool results", () => {
    const canvasUrl = "/__openclaw__/canvas/documents/cv_system/index.html";
    const mcpApp = {
      serverName: "system-monitor",
      toolName: "get-system-info",
      uiResourceUri: "ui://system-monitor/mcp-app.html",
      sessionKey: "agent:test:main",
      toolInput: {},
      toolResult: {
        content: [{ type: "text", text: "system info" }],
        structuredContent: { hostname: "openclaw-test" },
      },
    };

    const items = buildChatItems({
      sessionKey: "main",
      messages: [
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "system-monitor__get-system-info",
          timestamp: 1000,
          content: [
            { type: "text", text: "system info" },
            {
              type: "text",
              text: JSON.stringify({
                kind: "canvas",
                view: { id: "cv_system", url: canvasUrl, title: "get-system-info UI" },
                presentation: {
                  target: "assistant_message",
                  title: "get-system-info UI",
                  preferred_height: 600,
                },
                mcpApp,
              }),
            },
          ],
        },
        {
          role: "assistant",
          timestamp: 2000,
          content: `Here's the live system info.\n\n[embed url="${canvasUrl}" title="get-system-info UI" height="600" /]`,
        },
      ],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });

    const assistantGroup = items.find(
      (item) => item.kind === "group" && item.role.toLowerCase() === "assistant",
    );
    expect(assistantGroup).toBeTruthy();
    if (!assistantGroup || assistantGroup.kind !== "group") {
      return;
    }

    const assistantMessage = assistantGroup.messages[0]?.message as
      | { content?: unknown }
      | undefined;
    expect(Array.isArray(assistantMessage?.content)).toBe(true);
    const content = assistantMessage?.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toBe("Here's the live system info.");
    expect(content[1]?.type).toBe("canvas");
    expect(content[1]?.preview).toMatchObject({
      kind: "canvas",
      viewId: "cv_system",
      url: canvasUrl,
      mcpApp,
    });
  });
});
