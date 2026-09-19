/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message.ts";

function renderAssistantMessage(
  container: HTMLElement,
  content: unknown,
  options: { showToolCalls?: boolean } = {},
) {
  const [group] = groupMessages([
    {
      kind: "message",
      key: "assistant-message",
      message: { role: "assistant", content, timestamp: Date.now() },
    },
  ]);
  if (group?.kind !== "group") {
    throw new Error("expected an assistant message group");
  }
  render(
    renderMessageGroup(group, {
      showReasoning: true,
      showToolCalls: options.showToolCalls ?? true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
    }),
    container,
  );
}

describe("omitted chat history media", () => {
  it.each([
    { type: "input_image", omitted: true, bytes: 26 },
    { type: "input_image", omitted: true, bytes: 27, image_url: { detail: "high" } },
    {
      type: "input_image",
      omitted: true,
      bytes: 16,
      source: { media_type: "image/png" },
    },
  ])("shows a visible fallback for $type blocks", (block) => {
    const container = document.createElement("div");
    renderAssistantMessage(container, [block]);

    expect(container.querySelector(".chat-assistant-attachment-card")).not.toBeNull();
    expect(container.textContent).toContain("Image");
    expect(container.textContent).toContain("History");
    expect(container.textContent).toContain("Omitted from history");
  });

  it("shows the fallback for nested tool results when tool cards are hidden", () => {
    const container = document.createElement("div");
    renderAssistantMessage(
      container,
      [
        { type: "toolcall", id: "nested-image-call", name: "image", arguments: {} },
        {
          type: "toolResult",
          id: "nested-image-call",
          content: [{ type: "input_image", omitted: true, bytes: 26 }],
        },
      ],
      { showToolCalls: false },
    );

    expect(container.querySelector(".chat-assistant-attachment-card")).not.toBeNull();
    expect(container.textContent).toContain("Omitted from history");
  });
});
