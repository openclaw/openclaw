/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import { renderMessageGroup } from "./grouped-render.ts";

function createGroup(): MessageGroup {
  return {
    kind: "group",
    key: "group:assistant:msg:1",
    role: "assistant",
    messages: [
      {
        key: "msg:1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reply to this" }],
          timestamp: 1000,
        },
      },
    ],
    timestamp: 1000,
    isStreaming: false,
  };
}

afterEach(() => {
  document.body.querySelector(".chat-reply-context-menu")?.remove();
});

describe("grouped chat rendering", () => {
  it("opens a Reply menu on message contextmenu", async () => {
    const container = document.createElement("div");
    const onReply = vi.fn();
    render(
      renderMessageGroup(createGroup(), {
        onReply,
        showReasoning: false,
      }),
      container,
    );

    container.querySelector<HTMLElement>(".chat-bubble")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 18,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const item = document.body.querySelector<HTMLButtonElement>(".chat-reply-context-menu__item");
    expect(item?.textContent).toBe("Reply");
    item?.click();

    expect(onReply).toHaveBeenCalledWith({
      key: "msg:1",
      role: "assistant",
      text: "Reply to this",
    });
    expect(document.body.querySelector(".chat-reply-context-menu")).toBeNull();
  });

  it("renders a keyboard-accessible Reply button for message bubbles", () => {
    const container = document.createElement("div");
    const onReply = vi.fn();
    render(
      renderMessageGroup(createGroup(), {
        onReply,
        showReasoning: false,
      }),
      container,
    );

    const replyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Reply"]');
    expect(replyButton).not.toBeNull();
    replyButton?.click();

    expect(onReply).toHaveBeenCalledWith({
      key: "msg:1",
      role: "assistant",
      text: "Reply to this",
    });
  });
});
