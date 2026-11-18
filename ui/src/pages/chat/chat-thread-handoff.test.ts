// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  getExpandedToolCards,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

// A handoff makes the pane reload history: stored rows replace the live ones
// under other message keys, and the handed-off run's live rows linger briefly.

function preparedGroup(key: string, message: unknown): MessageGroup {
  const [group] = groupMessages([{ kind: "message", key, message }]);
  expect(group?.kind).toBe("group");
  return group as MessageGroup;
}

describe("the working status after a handoff", () => {
  const readingIndicator = (props: Partial<CachedChatItemsProps>) =>
    buildCachedChatItems(createProps(props)).find((item) => item.kind === "reading-indicator");
  it("does not lend a handed-off run's leftover live rows to the status that follows", () => {
    resetChatThreadState();
    const handoff = [
      {
        role: "assistant",
        runId: "handed-off",
        timestamp: 2_000,
        content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
      },
      {
        role: "toolResult",
        runId: "handed-off",
        toolCallId: "yield",
        toolName: "sessions_yield",
        timestamp: 2_001,
        content: [{ type: "text", text: '{"status":"yielded"}' }],
      },
    ];
    // The handed-off run's live tool rows are still held when the agent resumes.
    const leftover = {
      role: "toolResult",
      toolCallId: "launch",
      toolName: "sessions_spawn",
      content: "accepted",
      timestamp: 1_500,
      runId: "handed-off",
      __openclawToolStreamReceivedAt: 1_500,
    };
    const before = Date.now();
    const resumed = readingIndicator({
      sessionKey: "agent:main:resumed-after-handoff",
      runWorking: true,
      messages: handoff,
      toolMessages: [leftover],
    });
    expect(resumed).not.toHaveProperty("runId");
    expect(resumed?.startedAt).toBeGreaterThanOrEqual(before);

    // Without a handoff those rows are the running turn's own.
    resetChatThreadState();
    expect(
      readingIndicator({
        sessionKey: "agent:main:still-running",
        runWorking: true,
        toolMessages: [leftover],
      }),
    ).toMatchObject({ runId: "handed-off", startedAt: 1_500 });
  });
});

describe("opened tool rows across a handoff", () => {
  it.each(["browser.open", "sessions_spawn", "view_image"] as const)(
    "carries opened %s disclosures to the stored rows that replace live ones",
    (name) => {
      resetChatThreadState();
      const sessionKey = "handoff-swaps-live-rows";
      const lifecycle = name === "sessions_spawn";
      const image = name === "view_image";
      const group = (key: string) => {
        const stored = key === "stored-row";
        return preparedGroup(key, {
          role: image && stored ? "toolResult" : "assistant",
          ...(image ? { toolCallId: "call-1" } : {}),
          content: [
            {
              type: "toolcall",
              id: "call-1",
              name,
              arguments: image ? { path: "/tmp/preview.png" } : { label: "Cinder", task: "Work" },
            },
            ...(image
              ? [{ type: "tool_result", id: "call-1", name, text: "Loaded image for inspection." }]
              : []),
            // The stored row publishes the image as its own message.
            ...(image && stored
              ? [{ type: "image", mimeType: "image/png", omitted: true, artifactId: "preview" }]
              : []),
          ],
        });
      };
      const card = (key: string) =>
        image && key === "stored-row" ? "toolmsg:stored-row" : `${key}:toolcard:0`;
      // The disclosure around the row: its activity group, or the lifecycle row it joins.
      const outer = (key: string, current: MessageGroup) =>
        lifecycle ? `lifecycle:${key}:toolcard:0` : image ? card(key) : `activity:${current.key}`;
      const live = [group("live-row")];
      syncToolCardExpansionState(sessionKey, live, lifecycle, false, undefined, live);
      const expanded = getExpandedToolCards(sessionKey);
      setExpansionState(expanded, "live-row:toolcard:0", !lifecycle);
      setExpansionState(expanded, outer("live-row", live[0]!), true);

      // A handoff reloads the same call under another message key.
      const stored = [group("stored-row")];
      syncToolCardExpansionState(sessionKey, stored, false, false, undefined, stored);

      expect(expanded.get(card("stored-row"))).toBe(!lifecycle);
      expect(expanded.get(outer("stored-row", stored[0]!))).toBe(true);
      // Another pane can still hold the live history window.
      expect(expanded.get("live-row:toolcard:0")).toBe(!lifecycle);
      expect(expanded.get(outer("live-row", live[0]!))).toBe(true);
    },
  );

  it("does not carry an opened row between messages that reuse one call id", () => {
    resetChatThreadState();
    const sessionKey = "reused-call-ids-stay-apart";
    const group = (key: string) =>
      preparedGroup(key, {
        role: "assistant",
        content: [{ type: "toolcall", id: "shared-call", name: "browser.open" }],
      });
    syncToolCardExpansionState(sessionKey, [group("first"), group("second")], false);
    const expanded = getExpandedToolCards(sessionKey);
    setExpansionState(expanded, "first:toolcard:0", true);

    syncToolCardExpansionState(sessionKey, [group("third"), group("fourth")], false);

    expect(expanded.get("third:toolcard:0")).toBe(false);
    expect(expanded.get("fourth:toolcard:0")).toBe(false);
  });
});
