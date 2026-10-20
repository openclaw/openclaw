// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { message, text, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import {
  getExpandedToolCards,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

function group(key: string, id: string): MessageGroup {
  const raw = message("assistant", [{ type: "toolcall", id, name: "browser.open" }]);
  const [result] = groupMessages([{ kind: "message", key, message: raw }]);
  expect(result?.kind).toBe("group");
  return result as MessageGroup;
}
const reading = (props: Partial<CachedChatItemsProps>) =>
  buildItems({ runWorking: true, ...props }).find((item) => item.kind === "reading-indicator");

it("does not lend a handed-off run's leftover live rows to the status that follows", () => {
  const handoff = [
    message(
      "assistant",
      [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
      2000,
      { runId: "handed-off" },
    ),
    toolResult("yield", "sessions_yield", [text('{"status":"yielded"}')], 2001, {
      runId: "handed-off",
    }),
  ];
  const leftover = toolResult("launch", "sessions_spawn", "accepted", 1500, {
    runId: "handed-off",
    __openclawToolStreamReceivedAt: 1500,
  });
  const before = Date.now();
  const resumed = reading({
    sessionKey: "agent:main:resumed-after-handoff",
    messages: handoff,
    toolMessages: [leftover],
  });
  expect(resumed).not.toHaveProperty("runId");
  expect(resumed?.startedAt).toBeGreaterThanOrEqual(before);
  // Without a handoff those rows still belong to the running turn.
  resetChatThreadState();
  expect(
    reading({ sessionKey: "agent:main:still-running", toolMessages: [leftover] }),
  ).toMatchObject({ runId: "handed-off", startedAt: 1_500 });
});

it.each([
  ["unique call", ["live-row"], ["stored-row"], true],
  ["reused call", ["first", "second"], ["third", "fourth"], false],
] as const)("retains expansion correctly for a %s", (callId, before, after, transfers) => {
  const sessionKey = "handoff-expansion";
  syncToolCardExpansionState(
    sessionKey,
    before.map((key) => group(key, callId)),
    false,
  );
  const expanded = getExpandedToolCards(sessionKey);
  setExpansionState(expanded, `${before[0]}:toolcard:0`, true);
  if (transfers) {
    setExpansionState(expanded, `activity:${before[0]}`, true);
  }
  syncToolCardExpansionState(
    sessionKey,
    after.map((key) => group(key, callId)),
    false,
  );
  for (const key of after) {
    expect(expanded.get(`${key}:toolcard:0`)).toBe(transfers);
  }
  if (transfers) {
    expect(expanded.get(`activity:${after[0]}`)).toBe(true);
    expect(expanded.get(`${before[0]}:toolcard:0`)).toBe(true);
    expect(expanded.get(`activity:${before[0]}`)).toBe(true);
  }
});
