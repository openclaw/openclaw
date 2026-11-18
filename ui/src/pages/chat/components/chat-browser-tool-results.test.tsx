/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { ActivityGroup, MessageGroup as MessageGroupView } from "./chat-message-group-view.tsx";

const hosts: HTMLElement[] = [];
afterEach(() => {
  cleanupSolid();
  for (const host of hosts.splice(0)) {
    host.remove();
  }
});

function browserResultGroup(
  messages: Array<{ toolCallId: string }>,
  key = "browser-results",
): MessageGroup {
  return {
    kind: "group",
    key,
    role: "tool",
    visibleContent: "text",
    isStreaming: false,
    timestamp: 1,
    messages: groupMessages(
      messages.map((message) => ({ kind: "message", key: message.toolCallId, message })),
    ).flatMap((item) => (item.kind === "group" ? item.messages : [])),
  };
}

function container() {
  const host = document.createElement("div");
  hosts.push(host);
  document.body.append(host);
  return host;
}

function browserResult(id: string, targetId: string, url: string | undefined) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "browser",
    content: "Inspected the requested page.",
    details: { browserTab: { profile: "managed", target: "host", targetId, url, title: id } },
  };
}

describe("browser tool results", () => {
  it.each([
    ["activity", false],
    ["activity", true],
    ["message", false],
    ["message", true],
    ["inline", false],
    ["inline", true],
  ] as const)(
    "keeps %s browser output without preview cards (bubbles: %s)",
    async (route, bubbleMode) => {
      const messages = [
        browserResult("verify-a", "tab-1", "https://example.com/pull/1"),
        browserResult("verify-b", "tab-2", "https://example.com/pull/1"),
      ];
      const groups = [browserResultGroup(messages)];
      const inlineCommands = route === "inline" ? await inlineCommandPresentation() : undefined;
      const options = (expanded: boolean) => ({
        showReasoning: false,
        bubbleMode,
        inlineCommands,
        isToolMessageExpanded: () => expanded,
        isToolExpanded: () => expanded,
      });
      const view = mountSolid(
        (props: { expanded: boolean }) => (
          <>
            {route !== "message" ? (
              <ActivityGroup
                groups={groups}
                options={options(props.expanded)}
                presentation="standalone"
              />
            ) : (
              <MessageGroupView group={groups[0]!} options={options(props.expanded)} />
            )}
          </>
        ),
        { expanded: true },
        container(),
      );
      await waitForSolid(() =>
        expect(view.container.querySelectorAll(".chat-tool-msg-body")).toHaveLength(2),
      );
      expect(view.container.querySelector("openclaw-browser-tab-card")).toBeNull();
      await waitForSolid(() =>
        expect(view.container.textContent).toContain("Inspected the requested page."),
      );
      view.update({ expanded: false });
      await waitForSolid(() =>
        expect(view.container.querySelector("openclaw-browser-tab-card")).toBeNull(),
      );
    },
  );
});
