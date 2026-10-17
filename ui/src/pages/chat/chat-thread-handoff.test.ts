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
  it("carries what the reader opened to the stored rows that replace live ones", () => {
    resetChatThreadState();
    const sessionKey = "handoff-swaps-live-rows";
    const group = (key: string, id: string) =>
      preparedGroup(key, {
        role: "assistant",
        content: [{ type: "toolcall", id, name: "browser.open" }],
      });
    const live = [group("live-row", "call-1")];
    syncToolCardExpansionState(sessionKey, live, false);
    const expanded = getExpandedToolCards(sessionKey);
    setExpansionState(expanded, "live-row:toolcard:0", true);
    setExpansionState(expanded, `activity:${live[0]!.key}`, true);

    // A handoff reloads the same call under another message key.
    const stored = [group("stored-row", "call-1")];
    syncToolCardExpansionState(sessionKey, stored, false);

    expect(expanded.get("stored-row:toolcard:0")).toBe(true);
    expect(expanded.get(`activity:${stored[0]!.key}`)).toBe(true);
    expect(expanded.has("live-row:toolcard:0")).toBe(false);
    expect(expanded.has(`activity:${live[0]!.key}`)).toBe(false);
  });

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
