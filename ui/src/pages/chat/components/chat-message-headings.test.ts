/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMessageGroup } from "./chat-message-group.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  render(nothing, container);
  container.remove();
});

describe("chat message headings", () => {
  it.each([
    { role: "user", label: "You", options: { showOwnSenderName: false } },
    { role: "user", label: "Alex", options: { userName: "Alex" } },
    { role: "assistant", label: "OpenClaw", options: {} },
  ])("places a $label heading before $role content", ({ role, label, options }) => {
    render(
      renderMessageGroup(createMessageGroup({ role, content: "A conversational message" }, role), {
        assistantName: "OpenClaw",
        showReasoning: false,
        ...options,
      }),
      container,
    );
    const headings = container.querySelectorAll("h2");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(label);
    expect(
      headings[0]!.compareDocumentPosition(container.querySelector(".chat-bubble")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps one sender heading as an assistant stream grows and settles", () => {
    const draw = (text: string, isStreaming: boolean) =>
      render(
        renderStreamGroup([{ kind: "stream", key: "answer", text, startedAt: 1000, isStreaming }], {
          assistant: { name: "OpenClaw", avatar: null },
        }),
        container,
      );
    draw("First", true);
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("OpenClaw");
    draw("First and second", true);
    expect(container.querySelector("h2")).toBe(heading);
    draw("First and second", false);
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(container.querySelector("h2")).toBe(heading);
  });
});
