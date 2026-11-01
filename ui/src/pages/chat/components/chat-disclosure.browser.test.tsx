import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid as mountView } from "../../../test-helpers/mount-solid.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatActivityHeadline } from "./chat-activity-headline.solid.tsx";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import { RawOutputToggle } from "./chat-tool-content.solid.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { WorkGroupSummary } from "./chat-work-group-summary.tsx";

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
    container.remove();
  }
});

function group(
  key: string,
  message: MessageGroupData["messages"][number]["message"],
  role: MessageGroupData["role"] = "tool",
): MessageGroupData {
  return {
    kind: "group",
    key,
    role,
    timestamp: 1000,
    isStreaming: false,
    visibleContent: role === "assistant" ? "text" : "non-text",
    messages: [{ key, hasVisibleContent: true, message }],
  };
}

describe.runIf(browserMode)("chat disclosure activation", () => {
  it.each(["work", "activity", "tool", "tool-output", "raw"] as const)(
    "toggles on rapid clicks without selecting labels and retains keyboard access (%s)",
    async (kind) => {
      container = document.body.appendChild(document.createElement("div"));
      const groups = [
        group("activity", {
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
        }),
      ];
      const output = group("output", {
        role: "toolResult",
        toolCallId: "search",
        toolName: "web_search",
        content: "Search results",
      });
      let expanded = false;
      const toggle = () => {
        expanded = !expanded;
        draw();
      };
      function Disclosure(props: { expanded: boolean }) {
        const options = () => ({
          showToolCalls: true,
          showReasoning: false,
          isToolMessageExpanded: () => props.expanded,
          onToggleToolMessageExpanded: toggle,
        });
        return (
          <>
            {kind === "work" ? (
              <WorkGroupSummary
                item={{ key: "work", durationMs: null, groups }}
                options={{ expanded: props.expanded, onToggle: toggle }}
              />
            ) : kind === "activity" ? (
              <ActivityGroup groups={groups} options={options()} presentation="standalone" />
            ) : kind === "tool" ? (
              <ChatToolCard
                card={{
                  id: "search",
                  name: "web_search",
                  args: { query: "disclosures" },
                  completed: true,
                }}
                options={{ messageKey: "tool", expanded: props.expanded, onToggleExpanded: toggle }}
              />
            ) : kind === "tool-output" ? (
              <MessageGroup group={output} options={options()} />
            ) : (
              <openclaw-chat-tool-raw>
                <RawOutputToggle text="Copyable output" />
              </openclaw-chat-tool-raw>
            )}
          </>
        );
      }
      const view = mountSolid(Disclosure, { expanded }, container);
      const draw = () => view.update({ expanded });
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

  it("dims live operation text until hover or keyboard focus without a tooltip", async () => {
    container = document.body.appendChild(document.createElement("div"));
    const view = mountView(
      () => (
        <ContentPresentation value={() => true}>
          <button class="chat-inline-disclosure chat-activity-group__summary">
            <ChatActivityHeadline
              scope="hover-proof"
              activity={{
                key: "search",
                name: "tool_search",
                title: "Find available tools",
                status: "running",
              }}
              summary="5 other operations"
            />
          </button>
        </ContentPresentation>
      ),
      { container },
    );
    try {
      const button = container.querySelector<HTMLButtonElement>("button")!;
      const label = container.querySelector<HTMLElement>(".chat-activity-group__label")!;
      const icon = container.querySelector<HTMLElement>(".chat-activity-group__icon")!;
      // Isolate the state assertions from the production color transition.
      button.style.transition = "none";
      await userEvent.hover(document.body, { position: { x: 0, y: 0 } });
      const resting = getComputedStyle(label).color;
      expect(resting).toBe(getComputedStyle(button).color);
      expect(icon.getAttribute("aria-label")).toBe("tool_search");
      expect(button.querySelector("[title]")).toBeNull();
      await userEvent.hover(icon);
      const hovered = getComputedStyle(label).color;
      expect(hovered).not.toBe(resting);
      expect(hovered).toBe(getComputedStyle(button).color);
      await userEvent.hover(document.body, { position: { x: 0, y: 0 } });
      expect(getComputedStyle(label).color).toBe(resting);
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(label).color).toBe(hovered);
    } finally {
      view.unmount();
    }
  });

  it("keeps message prose and expanded output selectable", async () => {
    container = document.body.appendChild(document.createElement("div"));
    mountView(
      () => (
        <>
          <MessageGroup
            group={group(
              "answer",
              { role: "assistant", content: "Copyable explanation." },
              "assistant",
            )}
            options={{ showReasoning: false }}
          />
          <openclaw-chat-tool-raw>
            <RawOutputToggle text="Copyable output" />
          </openclaw-chat-tool-raw>
        </>
      ),
      { container },
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
