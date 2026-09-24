import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

describe("plugin activity icons", () => {
  it.each([
    ["assistant", "meeting_status"],
    ["toolResult", "meeting_status"],
    ["assistant", "mcp__other__browser"],
    ["toolResult", "mcp__other__browser"],
    ["assistant", "memory_search"],
    ["assistant", "lobster"],
  ])(
    "uses the owner's monochrome mask for %s %s rows and restores the fallback after failure",
    (role, name) => {
      const container = document.createElement("div");
      const message =
        role === "assistant"
          ? {
              role,
              content: [{ type: "toolCall", id: "call", name, arguments: { command: "run" } }],
            }
          : {
              role,
              toolCallId: "call",
              toolName: name,
              content: [{ type: "text", text: "No active meetings." }],
            };
      const onError = vi.fn();
      const options = {
        isStreaming: false,
        showReasoning: false,
        showToolCalls: true,
        pluginToolIcons: new Map([[name, { url: "blob:activity-icon", onError }]]),
      };
      render(
        renderGroupedMessage(prepareChatMessageRender(message), "message", options),
        container,
      );
      const mask = container.querySelector<HTMLElement>(".chat-tool-activity-icon");
      expect(mask?.style.maskImage).toBe('url("blob:activity-icon")');
      expect(mask?.getAttribute("aria-hidden")).toBe("true");
      const icon = mask?.querySelector<HTMLImageElement>("img");
      expect(icon?.hidden).toBe(true);
      expect(icon?.getAttribute("src")).toBe("blob:activity-icon");
      expect(container.querySelector(".chat-tool-msg-summary__icon svg")).toBeNull();
      icon?.dispatchEvent(new Event("error"));
      expect(onError).toHaveBeenCalledOnce();

      render(
        renderGroupedMessage(prepareChatMessageRender(message), "message", {
          ...options,
          pluginToolIcons: new Map(),
        }),
        container,
      );
      expect(container.querySelector(".chat-tool-activity-icon")).toBeNull();
      expect(container.querySelector(".chat-tool-msg-summary__icon img")).toBeNull();
      expect(container.querySelector(".chat-tool-msg-summary__icon svg")).not.toBeNull();
    },
  );
});
