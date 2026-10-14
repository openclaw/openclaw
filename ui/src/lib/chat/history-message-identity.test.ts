import { expect, it, vi } from "vitest";
import {
  nativeHistoryMessageIdentity,
  prependUniqueNativeMessages,
} from "./history-message-identity.ts";

function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

it("keeps multiple projected messages from the same transcript sequence", () => {
  const projected = [
    {
      ...nativeHistoryMessage(1, "Same routed send"),
      openclawMessageToolMirror: { toolName: "message", toolCallId: "call-a" },
    },
    {
      ...nativeHistoryMessage(1, "Same routed send"),
      openclawMessageToolMirror: { toolName: "message", toolCallId: "call-b" },
    },
  ];

  expect(prependUniqueNativeMessages(projected, [nativeHistoryMessage(2)])).toEqual([
    ...projected,
    nativeHistoryMessage(2),
  ]);
  expect(prependUniqueNativeMessages(projected, projected)).toEqual(projected);
  expect(prependUniqueNativeMessages(projected, [projected[1], nativeHistoryMessage(2)])).toEqual([
    projected[0],
    projected[1],
    nativeHistoryMessage(2),
  ]);

  const current = [...projected, projected[1]];
  expect(prependUniqueNativeMessages([...projected, projected[1], projected[1]], current)).toEqual([
    projected[1],
    ...current,
  ]);
  const unidentified = { role: "assistant", content: "No source identity" };
  expect(prependUniqueNativeMessages([unidentified], [unidentified])).toEqual([
    unidentified,
    unidentified,
  ]);
});

it("deduplicates byte-different live-event and history projections of one transcript row", () => {
  const liveEventProjection = {
    role: "assistant",
    content: [{ type: "text", text: "One stored reply" }],
    __openclaw: {
      id: "assistant-message-42",
      idempotencyKey: "run-42",
      seq: 42,
    },
  };
  const historyProjection = {
    role: "assistant",
    content: [{ type: "text", text: "One stored reply" }],
    __openclaw: {
      id: "assistant-message-42",
      idempotencyKey: "run-42",
      recordTimestampMs: 1_786_000_000_000,
      seq: 42,
    },
  };

  expect(nativeHistoryMessageIdentity(liveEventProjection)).toBe(
    nativeHistoryMessageIdentity(historyProjection),
  );
  expect(prependUniqueNativeMessages([historyProjection], [liveEventProjection])).toEqual([
    liveEventProjection,
  ]);
});

it.each([0, 50])("bounds prepend serialization with %i overlapping rows", (overlap) => {
  const text = "Synthetic history content. ".repeat(300);
  const older = Array.from({ length: 1000 }, (_, index) => nativeHistoryMessage(index + 1, text));
  const current = Array.from({ length: 1000 }, (_, index) =>
    nativeHistoryMessage(1001 - overlap + index, text),
  );
  const stringify = JSON.stringify;
  let serializedCharacters = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const result = Reflect.apply(stringify, JSON, args);
    serializedCharacters += result?.length ?? 0;
    return result;
  });
  let merged: unknown[];
  try {
    merged = prependUniqueNativeMessages(older, current);
  } finally {
    serialization.mockRestore();
  }
  expect(merged).toEqual([...older.slice(0, older.length - overlap), ...current]);
  // The budget scales with the shared boundary, not the accumulated transcript.
  expect(serializedCharacters).toBeLessThanOrEqual((overlap * 2 + 4) * text.length * 1.1);
});
