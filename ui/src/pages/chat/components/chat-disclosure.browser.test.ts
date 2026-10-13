import { html, nothing, render } from "lit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderActivityGroup, renderMessageGroup } from "./chat-message-group.ts";
import { renderWorkGroupSummary } from "./chat-message-stream.ts";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderRawOutputToggle } from "./chat-tool-content.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
let container: HTMLDivElement;
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  if (container) {
    render(nothing, container);
    container.remove();
  }
});

describe.runIf(browserMode)("chat disclosure activation", () => {
  it.each(["work", "activity", "tool", "tool-output", "raw"] as const)(
    "toggles on rapid clicks without selecting labels and retains keyboard access (%s)",
    async (kind) => {
      container = document.body.appendChild(document.createElement("div"));
      const groups: MessageGroup[] = [
        {
          kind: "group",
          key: "activity",
          role: "tool",
          timestamp: 1000,
          isStreaming: false,
          visibleContent: "non-text",
          messages: [
            {
              key: "call",
              hasVisibleContent: true,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "search",
                    name: "web_search",
                    arguments: { query: "disclosures" },
                  },
                ],
                activity: [
                  {
                    itemId: "search",
                    toolCallId: "search",
                    kind: "tool",
                    phase: "end",
                    name: "web_search",
                    title: "Search",
                    status: "completed",
                  },
                ],
              },
            },
          ],
        },
      ];
      const output: MessageGroup = {
        kind: "group",
        key: "output",
        role: "tool",
        timestamp: 1000,
        isStreaming: false,
        visibleContent: "non-text",
        messages: [
          {
            key: "result",
            hasVisibleContent: true,
            message: {
              role: "toolResult",
              toolCallId: "search",
              toolName: "web_search",
              content: "Search results",
            },
          },
        ],
      };
      let expanded = false;
      const toggle = () => {
        expanded = !expanded;
        draw();
      };
      const draw = () => {
        const options = {
          showToolCalls: true,
          showReasoning: false,
          isToolMessageExpanded: () => expanded,
          onToggleToolMessageExpanded: toggle,
        };
        render(
          kind === "work"
            ? renderWorkGroupSummary(
                { key: "work", durationMs: null, groups },
                { expanded, onToggle: toggle },
              )
            : kind === "activity"
              ? renderActivityGroup(groups, options)
              : kind === "tool"
                ? renderToolCard(
                    {
                      id: "search",
                      name: "web_search",
                      args: { query: "disclosures" },
                      completed: true,
                    },
                    { messageKey: "tool", expanded, onToggleExpanded: toggle },
                  )
                : kind === "tool-output"
                  ? renderMessageGroup(output, options)
                  : renderRawOutputToggle("Copyable output"),
          container,
        );
      };
      draw();
      await settleToolBridges(container);
      const button = container.querySelector<HTMLButtonElement>(".chat-inline-disclosure")!;
      const label = (button.querySelector<HTMLElement>(
        ".chat-activity-group__label, .chat-tool-msg-summary__label, .chat-tool-msg-summary__names",
      ) ?? button.querySelector<HTMLElement>("span"))!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      // Real pointer events exercise browser word selection before the second click.
      await userEvent.dblClick(label);
      expect(window.getSelection()?.toString()).toBe("");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(label);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await userEvent.keyboard("{Enter}");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      await userEvent.keyboard(" ");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
    },
  );

  it("keeps message prose and expanded output selectable", async () => {
    container = document.body.appendChild(document.createElement("div"));
    render(
      html`
        ${renderMessageGroup(
          {
            kind: "group",
            key: "answer",
            role: "assistant",
            timestamp: 1000,
            isStreaming: false,
            visibleContent: "text",
            messages: [
              {
                key: "answer",
                hasVisibleContent: true,
                message: { role: "assistant", content: "Copyable explanation." },
              },
            ],
          },
          { showReasoning: false },
        )}
        ${renderRawOutputToggle("Copyable output")}
      `,
      container,
    );
    await settleToolBridges(container);
    const prose = container.querySelector<HTMLElement>(".chat-text p")!;
    await userEvent.dblClick(prose);
    expect(window.getSelection()?.toString()).not.toBe("");
    window.getSelection()?.removeAllRanges();
    await userEvent.click(
      container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle")!,
    );
    await userEvent.dblClick(
      container.querySelector<HTMLElement>(".chat-tool-card__raw-body code")!,
    );
    expect(window.getSelection()?.toString()).not.toBe("");
  });
});
