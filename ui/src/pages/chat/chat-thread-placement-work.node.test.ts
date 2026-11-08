// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { message, nativeMessage, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { insertChatItemsByTimestamp, type ChatProjection } from "./chat-thread-items.ts";
import { createRunTurnLookup } from "./chat-thread-run-identity.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import * as causalBoundary from "./stream-causal-boundary.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetChatThreadState();
});

it("does not repeat history placement scans for sibling live tools", () => {
  const scans = vi.spyOn(causalBoundary, "knownStreamCausalInterval");
  const measure = (count: number) => {
    scans.mockClear();
    const groups = buildCachedChatItems(
      createProps({
        runId: "live-run",
        messages: [message("user", "Earlier prompt", 1), message("assistant", "Earlier reply", 2)],
        toolMessages: Array.from({ length: count }, (_, index) =>
          toolResult(`live-${index}`, "shell", `Result ${index}`, index + 3, {
            runId: "live-run",
          }),
        ),
      }),
    ).filter((item) => item.kind === "group");
    const cards = groups.flatMap((group) =>
      group.messages.flatMap(({ message: source }) => extractToolCardsCached(source)),
    );
    expect(cards).toHaveLength(count);
    return scans.mock.calls.length;
  };
  const single = measure(1);
  // Canvas and live placement share the unchanged history snapshot.
  expect(single).toBe(1);
  expect(measure(50)).toBe(single);
});

it("shares causal placement only for the same run and input within one snapshot", () => {
  const scans = vi.spyOn(causalBoundary, "knownStreamCausalInterval");
  const row = (key: string, role: string, metadata: object): ChatItem => ({
    kind: "message",
    key,
    message: nativeMessage(role, key, 1, metadata),
  });
  const items = [
    row("prompt-a", "user", { idempotencyKey: "input-a:user" }),
    row("output-a", "assistant", { runId: "run-a" }),
    row("prompt-b", "user", { idempotencyKey: "input-b:user" }),
    row("output-b", "assistant", { runId: "run-b" }),
    row("prompt-next", "user", { idempotencyKey: "input-next:user" }),
  ];
  const lookup = createRunTurnLookup(items);
  const cases = [
    { runId: "run-a", expected: { afterKey: "prompt-a", beforeKey: "prompt-b" } },
    { runId: "missing", expected: null },
    { runId: "run-b", expected: { afterKey: "prompt-b", beforeKey: "prompt-next" } },
    {
      runId: "missing",
      afterUserSendId: "paged-input",
      expected: { afterKey: undefined, beforeKey: "prompt-a" },
    },
  ];
  for (let round = 0; round < 3; round++) {
    for (const entry of cases) {
      expect(lookup(entry.runId, entry.afterUserSendId)).toEqual(entry.expected);
    }
  }
  expect(scans).toHaveBeenCalledTimes(cases.length);

  const refreshed = createRunTurnLookup([
    ...items,
    row("arrived-output", "assistant", { runId: "missing" }),
  ]);
  expect(refreshed("missing")).toEqual({ afterKey: "prompt-next", beforeKey: undefined });
  expect(refreshed("missing")).toEqual({ afterKey: "prompt-next", beforeKey: undefined });
  expect(scans).toHaveBeenCalledTimes(cases.length + 1);
});

function timedItem(key: string, timestamp?: number): ChatItem {
  return { kind: "message", key, message: { role: "assistant", content: key, timestamp } };
}

it("keeps stable clock order, equal times, predecessors and missing times within shared bounds", () => {
  const items = [timedItem("start", 100), timedItem("skewed", 4), timedItem("end", 20)];
  const bounds = { afterKey: "start", beforeKey: "end" };
  const inserts: ChatProjection[] = [
    { item: timedItem("follower", 2), predecessorKey: "leader", bounds },
    { item: timedItem("missing"), bounds },
    { item: timedItem("leader", 10), bounds },
    { item: timedItem("equal", 4), bounds },
    { item: timedItem("middle", 7), bounds },
  ];
  const stable = [...items];
  insertChatItemsByTimestamp(items, inserts);
  expect(items.map((item) => item.key)).toEqual([
    "start",
    "skewed",
    "equal",
    "middle",
    "leader",
    "follower",
    "missing",
    "end",
  ]);
  expect(items[0]).toBe(stable[0]);
  expect(items[1]).toBe(stable[1]);
  expect(items.at(-1)).toBe(stable[2]);
});

it.each([
  {
    name: "inverted",
    first: { afterKey: "end", beforeKey: "middle" },
    second: { afterKey: "end", beforeKey: "middle" },
    expected: ["start", "first", "second", "middle", "end"],
  },
  {
    name: "mixed",
    first: { beforeKey: "middle" },
    second: { afterKey: "end" },
    expected: ["start", "first", "middle", "end", "second"],
  },
  {
    name: "inserted endpoint",
    first: { beforeKey: "middle" },
    second: { afterKey: "first", beforeKey: "middle" },
    expected: ["start", "first", "second", "middle", "end"],
  },
])("preserves $name placement intervals", ({ first, second, expected }) => {
  const items = [timedItem("start", 0), timedItem("middle", 100), timedItem("end", 200)];
  insertChatItemsByTimestamp(items, [
    { item: timedItem("first", 10), bounds: first },
    { item: timedItem("second", 20), bounds: second },
  ]);
  expect(items.map((item) => item.key)).toEqual(expected);
});

it("does not reread earlier tool timestamps for each sibling in one placement interval", () => {
  let timestampReads = 0;
  const inserts: ChatProjection[] = Array.from({ length: 200 }, (_, index) => ({
    item: {
      kind: "message",
      key: `tool-${index}`,
      message: {
        role: "assistant",
        content: `Result ${index}`,
        get timestamp() {
          timestampReads += 1;
          return index + 1;
        },
      },
    },
    bounds: { afterKey: "start", beforeKey: "end" },
  }));
  const items = [timedItem("start", 0), timedItem("end", 1_000)];
  insertChatItemsByTimestamp(items, inserts);
  expect(items.map((item) => item.key)).toEqual([
    "start",
    ...Array.from({ length: 200 }, (_, index) => `tool-${index}`),
    "end",
  ]);
  expect(timestampReads).toBeLessThan(1_000);
});
