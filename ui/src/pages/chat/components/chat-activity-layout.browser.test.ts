import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderActivityGroup, renderMessageGroup } from "./chat-message-group.ts";

let container: HTMLDivElement | undefined;
afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
    container = undefined;
  }
});

function messageGroup(key: string, role: string, messages: unknown[]): MessageGroup {
  return {
    kind: "group",
    key,
    role,
    timestamp: 1000,
    isStreaming: false,
    visibleContent: "non-text",
    messages: messages.map((message, index) => ({
      key: key + index,
      message,
      hasVisibleContent: true,
    })),
  };
}

function activityFixture(note = "") {
  const runId = "activity-layout";
  const messages: unknown[] = Array.from({ length: 4 }, (_, index) => ({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "batch-" + index,
        name: "exec",
        runId,
        arguments: { title: "Batch " + (index + 1), code: "// Read project files" },
      },
    ],
    timestamp: 1000,
  }));
  for (let index = 0; index < 40; index++) {
    const id = "child-" + index;
    messages.push({
      role: "custom",
      content: [
        {
          type: "toolCall",
          id,
          name: "read",
          runId,
          parentToolCallId: "batch-" + Math.floor(index / 10),
          arguments: { path: "/workspace/source-" + index + ".ts" },
        },
        {
          type: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: "Source contents" }],
        },
        ...(index === 0 && note ? [{ type: "text", text: note }] : []),
      ],
      timestamp: 1000 + index,
    });
  }
  return messageGroup("activity", "tool", messages);
}

describe.runIf("__vitest_browser__" in globalThis)("activity group sizing", () => {
  it.each(["standalone", "inline"] as const)(
    "fits visible rows, caps expanded content, and shrinks after collapse (%s)",
    (presentation) => {
      container = document.body.appendChild(document.createElement("div"));
      container.style.width = "760px";
      const group = activityFixture();
      const expanded = new Set<string>();
      const opts = {
        showReasoning: false,
        isToolMessageExpanded: () => true,
        isToolExpanded: (id: string) => expanded.has(id),
        onToggleToolExpanded: (id: string) => {
          if (expanded.has(id)) {
            expanded.delete(id);
          } else {
            expanded.add(id);
          }
          draw();
        },
      };
      const draw = () => {
        const activity = renderActivityGroup(
          [group],
          opts,
          presentation === "inline" ? "continuation" : "standalone",
        );
        render(
          presentation === "inline"
            ? renderMessageGroup(
                messageGroup("frame", "assistant", [{ role: "assistant", content: "Finished." }]),
                {
                  ...opts,
                  frameContent: [activity],
                },
              )
            : activity,
          container!,
        );
      };
      draw();
      const body = container.querySelector<HTMLElement>(".chat-activity-group__body")!;
      const compactHeight = body.getBoundingClientRect().height;
      expect(body.querySelectorAll(":scope > .chat-bubble")).toHaveLength(4);
      expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(4);
      expect(body.scrollHeight).toBe(body.clientHeight);
      expect(compactHeight).toBeGreaterThan(0);
      expect(compactHeight).toBeLessThan(200);

      const toggle = () => body.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")!.click();
      toggle();
      expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(14);
      expect(body.getBoundingClientRect().height).toBeCloseTo(
        Math.min(420, window.innerHeight * 0.58),
        0,
      );
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      body.scrollTop = body.scrollHeight;
      expect(body.scrollTop).toBeGreaterThan(0);

      toggle();
      expect(body.getBoundingClientRect().height).toBe(compactHeight);
      expect(body.scrollHeight).toBe(body.clientHeight);
      expect(body.scrollTop).toBe(0);
    },
  );

  it("preserves non-tool text beside a card moved under its parent", () => {
    container = document.body.appendChild(document.createElement("div"));
    const note = "Keep this explanation visible.";
    render(
      renderActivityGroup([activityFixture(note)], {
        showReasoning: false,
        isToolMessageExpanded: () => true,
      }),
      container,
    );
    expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(4);
    expect(container.querySelectorAll(".chat-activity-group__body > .chat-bubble")).toHaveLength(5);
    expect(container.querySelector(".chat-text")?.textContent).toContain(note);
  });
});
