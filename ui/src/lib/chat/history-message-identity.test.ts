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
function expectPrepend(older: unknown[], current: unknown[], expected: unknown[]) {
  expect(prependUniqueNativeMessages(older, current)).toEqual(expected);
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
    merged = prependUniqueNativeMessages(older, current);
  } finally {
    serialization.mockRestore();
  }
  expect(merged).toEqual([...older.slice(0, older.length - overlap), ...current]);
  // The budget scales with the shared boundary, not the accumulated transcript.
  expect(serializedCharacters).toBeLessThanOrEqual((overlap * 2 + 4) * text.length * 1.1);
});
