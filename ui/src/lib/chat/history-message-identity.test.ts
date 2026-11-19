import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceId,
  nativeHistoryMessageSourceIdentity,
} from "./history-message-identity.ts";
import { prependUniqueNativeMessages } from "./history-message-merge.ts";

it("keeps roleless source boundaries and imported namespaces", () => {
  const marker = { type: "compaction", __openclaw: { id: "boundary", seq: 7 } };
  expect(nativeHistoryMessageSourceId(marker)).toBe("boundary");
  expect(nativeHistoryMessageSourceIdentity(marker)).toBe("id:boundary");
  const imported = (cliSessionId: string) => ({
    role: "assistant",
    content: "Same imported answer",
    __openclaw: {
      id: "boundary",
      importedFrom: "claude-cli",
      cliSessionId,
      externalId: "boundary",
    },
  });
  expect(nativeHistoryMessageSourceIdentity(imported("one"))).not.toBe(
    nativeHistoryMessageSourceIdentity(imported("two")),
  );
  expectPrepend([imported("one")], [imported("two")], [imported("one"), imported("two")]);
});

function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}
function expectPrepend(older: unknown[], current: unknown[], expected: unknown[]) {
  expect(prependUniqueNativeMessages(older, current).messages).toEqual(expected);
}

it("keeps multiple projected messages from the same transcript sequence", () => {
  const projected = ["call-a", "call-b"].map((toolCallId) =>
    Object.assign(nativeHistoryMessage(1, "Same routed send"), {
      openclawMessageToolMirror: { toolName: "message", toolCallId },
    }),
  );
  const next = nativeHistoryMessage(2);
  expectPrepend(projected, [next], [...projected, next]);
  expectPrepend(projected, projected, projected);
  expectPrepend(projected, [projected[1], next], [...projected, next]);
  const current = [...projected, projected[1]];
  expectPrepend([...projected, projected[1], projected[1]], current, [projected[1], ...current]);
  const unidentified = { role: "assistant", content: "No source identity" };
  expectPrepend([unidentified], [unidentified], [unidentified, unidentified]);
});

it.each([
  { incoming: ["a"], current: ["a"], expandedIncoming: false, expandedCurrent: false },
  { incoming: ["a", "b"], current: ["a"], expandedIncoming: false, expandedCurrent: true },
  { incoming: ["a"], current: ["a", "b"], expandedIncoming: true, expandedCurrent: false },
  { incoming: ["a"], current: ["b"], expandedIncoming: true, expandedCurrent: true },
  { incoming: ["a", "a"], current: ["a"], expandedIncoming: false, expandedCurrent: true },
])("records changed occurrence groups for $incoming against $current", (example) => {
  const result = prependUniqueNativeMessages(
    example.incoming.map((part) => nativeHistoryMessage(1, part)),
    example.current.map((part) => nativeHistoryMessage(1, part)),
  );
  expect(result.incomingExpandedSources).toEqual(
    new Set(example.expandedIncoming ? ["seq:1"] : []),
  );
  expect(result.currentExpandedSources).toEqual(new Set(example.expandedCurrent ? ["seq:1"] : []));
});

it("deduplicates byte-different live-event and history projections of one transcript row", () => {
  const liveEventProjection = {
    ...nativeHistoryMessage(42, "One stored reply"),
    __openclaw: { id: "assistant-message-42", idempotencyKey: "run-42", seq: 42 },
  };
  const historyProjection = {
    ...liveEventProjection,
    openclawResponsesInputReplay: { items: ["server replay state"] },
    __openclaw: {
      ...liveEventProjection["__openclaw"],
      recordTimestampMs: 1_786_000_000_000,
    },
  };

  expect(nativeHistoryMessageIdentity(liveEventProjection)).toBe(
    nativeHistoryMessageIdentity(historyProjection),
  );
  expectPrepend([historyProjection], [liveEventProjection], [liveEventProjection]);
});

it("keeps the page order around live sources already admitted inside an empty raw window", () => {
  const [first, second, third, fourth, fifth] = [1, 2, 3, 4, 5].map((seq) =>
    nativeHistoryMessage(seq),
  );
  expectPrepend(
    [first, { ...second }, third, { ...fourth }, fifth],
    [second, fourth],
    [first, second, third, fourth, fifth],
  );
  const retained = prependUniqueNativeMessages([first, { ...second }, third], [second]).messages;
  expect(retained[1]).toBe(second);
  expectPrepend(retained, [second, third, fourth], [first, second, third, fourth]);
  const fragments = ["a", "b"].map((part) =>
    Object.assign({}, second, { content: part, openclawStreamFallback: { itemId: part } }),
  );
  expectPrepend(
    [first, ...fragments.map((message) => ({ ...message })), third, { ...fourth }, fifth],
    [...fragments, fourth],
    [first, ...fragments, third, fourth, fifth],
  );
});

it.each([0, 50])("bounds prepend serialization with %i overlapping rows", (overlap) => {
  const text = "Synthetic history content. ".repeat(300);
  const page = (start: number) =>
    Array.from({ length: 1000 }, (_, index) => nativeHistoryMessage(start + index, text));
  const older = page(1),
    current = page(1001 - overlap);
  const stringify = JSON.stringify;
  let serializedCharacters = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const result = Reflect.apply(stringify, JSON, args);
    serializedCharacters += result?.length ?? 0;
    return result;
  });
  let merged: unknown[];
  try {
    merged = prependUniqueNativeMessages(older, current).messages;
  } finally {
    serialization.mockRestore();
  }
  expect(merged).toEqual([...older.slice(0, older.length - overlap), ...current]);
  // The budget scales with the shared boundary, not the accumulated transcript.
  expect(serializedCharacters).toBeLessThanOrEqual((overlap * 2 + 4) * text.length * 1.1);
});

it("keeps an unkeyed outcome after its matched source when merging a newer page", () => {
  const second = nativeHistoryMessage(2);
  const third = nativeHistoryMessage(3);
  const output = { role: "system", content: "Local command result" };
  const merged = prependUniqueNativeMessages([second, output], [{ ...second }, third]);
  expect(merged.messages).toEqual([second, output, third]);
  expect(merged.messages[1]).toBe(output);
  expect(merged.incomingExpandedSources.size).toBe(0);
  expect(merged.currentExpandedSources.size).toBe(0);
});

it("moves only recorded local occurrences without deduplicating other object occurrences", () => {
  const [first, second, third, fourth] = [1, 2, 3, 4].map((seq) => nativeHistoryMessage(seq));
  const output = { role: "system", content: "Local command result" };
  const entries = reduceSessionProjection(createSessionProjection({}, [second]), {
    type: "localOutput",
    message: output,
  }).entries.filter((entry) => entry.localOutput);
  const merged = prependUniqueNativeMessages(
    [first, { ...second }, third, { ...fourth }],
    [second, output, fourth, output],
    entries,
  );
  expect(merged.messages).toEqual([first, second, output, third, fourth, output]);
  expect(merged.messages.filter((message) => message === output)).toHaveLength(2);
  expect(merged.incomingExpandedSources.size).toBe(0);
  expect(merged.currentExpandedSources.size).toBe(0);
});

it("keeps source sibling occurrence and expansion facts while placing typed local output", () => {
  const [first, second, third, fourth] = [1, 2, 3, 4].map((seq) => nativeHistoryMessage(seq));
  const [left, right] = ["left", "right"].map((part) =>
    Object.assign({}, second, { content: part }),
  );
  const output = { role: "system", content: "Local command result" };
  const laterOutput = { role: "system", content: "Later command result" };
  const firstOutput = reduceSessionProjection(createSessionProjection({}, [second]), {
    type: "localOutput",
    message: output,
  });
  const entries = reduceSessionProjection(firstOutput, {
    type: "localOutput",
    message: laterOutput,
  }).entries.filter((entry) => entry.localOutput);
  const merged = prependUniqueNativeMessages(
    [first, { ...left }, { ...right }, { ...right }, third, { ...fourth }],
    [left, right, output, laterOutput, fourth],
    entries,
  );
  expect(merged.messages).toEqual([first, right, left, right, output, laterOutput, third, fourth]);
  expect(merged.messages[2]).toBe(left);
  expect(merged.messages[3]).toBe(right);
  expect(merged.incomingExpandedSources).toEqual(new Set());
  expect(merged.currentExpandedSources).toEqual(new Set(["seq:2"]));
});

it("leaves unowned rows and unanchored local output in their existing page order", () => {
  const [first, second, third, fourth] = [1, 2, 3, 4].map((seq) => nativeHistoryMessage(seq));
  const unanchored = { role: "system", content: "Earlier command result" };
  const live = { role: "assistant", content: "Live reply", idempotencyKey: "live" };
  const pending = { role: "user", content: "Pending prompt", idempotencyKey: "pending" };
  const imported = {
    role: "assistant",
    content: "Imported reply",
    __openclaw: { importedFrom: "cli", cliSessionId: "import", externalId: "row" },
  };
  const state = reduceSessionProjection(createSessionProjection({}), {
    type: "localOutput",
    message: unanchored,
  });
  const merged = prependUniqueNativeMessages(
    [first, { ...second }, third, { ...fourth }],
    [second, live, pending, imported, unanchored, fourth],
    state.entries,
  );
  expect(merged.messages).toEqual([
    first,
    second,
    third,
    live,
    pending,
    imported,
    unanchored,
    fourth,
  ]);
  expect(merged.messages.slice(3, 7)).toEqual([live, pending, imported, unanchored]);
  expect(state.entries[0]).toMatchObject({ localOutput: true, afterSequence: undefined });
});

it.each([false, true])(
  "keeps an already-correct anchored local before held unsequenced rows with later source=%s",
  (later) => {
    const [first, second, fourth] = [1, 2, 4].map((seq) => nativeHistoryMessage(seq));
    const output = { role: "system", content: "Local command result" };
    const live = { role: "assistant", content: "Live reply" };
    const pending = { role: "user", content: "Pending prompt" };
    const unowned = { role: "system", content: "Unowned presentation" };
    let state = reduceSessionProjection(createSessionProjection({}, [second]), {
      type: "localOutput",
      message: output,
    });
    state = reduceSessionProjection(state, {
      type: "messagePersisted",
      message: live,
      envelope: { runId: "live" },
    });
    state = reduceSessionProjection(state, {
      type: "sendPending",
      runId: "pending",
      message: pending,
    });
    expect(state.messages).toEqual([second, output, live, pending]);
    expect(state.entries.find((entry) => entry.message === live)).toMatchObject({ live: true });
    expect(state.entries.find((entry) => entry.message === pending)).toMatchObject({
      pending: true,
    });
    const current = [...state.messages, unowned, ...(later ? [fourth] : [])];
    const merged = prependUniqueNativeMessages(
      [first, { ...second }],
      current,
      state.entries.filter((entry) => entry.localOutput),
    );
    expect(merged.messages).toEqual([first, ...current]);
    expect(merged.messages[1 + current.indexOf(output)]).toBe(output);
    expect(merged.incomingExpandedSources.size).toBe(0);
    expect(merged.currentExpandedSources.size).toBe(0);
  },
);

it.each(["older", "newer"] as const)(
  "preserves authorized start occurrences and insertion order across a %s page",
  (direction) => {
    const [first, second, third] = [1, 2, 3].map((seq) => nativeHistoryMessage(seq));
    const firstOutput = { role: "system", content: "First local result" };
    const secondOutput = { role: "system", content: "Second local result" };
    let state = createSessionProjection({});
    for (const message of [firstOutput, secondOutput]) {
      state = reduceSessionProjection(state, { type: "localOutput", message, sourceEmpty: true });
    }
    state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [second] });
    const entries = state.entries.filter((entry) => entry.localOutput);
    expect(entries.every((entry) => entry.atHistoryStart)).toBe(true);
    const held = [...state.messages, firstOutput];
    const page = [first, { ...second }, third];
    const merged =
      direction === "older"
        ? prependUniqueNativeMessages(page, held, entries)
        : prependUniqueNativeMessages(held, page, entries);
    expect(merged.messages).toEqual(
      direction === "older"
        ? [firstOutput, secondOutput, first, second, third, firstOutput]
        : [firstOutput, secondOutput, ...page.slice(0, 2), firstOutput, third],
    );
    expect(merged.messages[0]).toBe(firstOutput);
    expect(merged.messages[1]).toBe(secondOutput);
    expect(merged.messages.filter((message) => message === firstOutput)).toHaveLength(2);
    expect(merged.incomingExpandedSources.size).toBe(0);
    expect(merged.currentExpandedSources.size).toBe(0);
  },
);
