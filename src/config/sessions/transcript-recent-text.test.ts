import { expect, it } from "vitest";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionTranscriptBoundedMessageTailOptions } from "./session-accessor.sqlite-projection-read.js";
import { readRecentTranscriptConversationText } from "./transcript-recent-text.js";

it.each([
  { newerPhysicalRows: 250, expectedText: ["old candidate"] },
  { newerPhysicalRows: 9_999, expectedText: ["old candidate"] },
  { newerPhysicalRows: 10_000, expectedText: [] },
])(
  "bounds candidate coverage in physical rows, not projected text ($newerPhysicalRows newer rows)",
  ({ newerPhysicalRows, expectedText }) => {
    const source: TranscriptEvent[] = [
      {
        type: "message",
        id: "target-row",
        message: {
          role: "user",
          content: "old candidate",
          __openclaw: { transport: { messageId: "target" } },
        },
      },
      ...Array.from({ length: newerPhysicalRows }, (_, index) => ({
        type: "message",
        id: `tool-${index}`,
        message: { role: "toolResult", content: "non-conversation activity" },
      })),
    ];
    let scanned = 0;
    const readPage = ({ offset, maxMessages }: SessionTranscriptBoundedMessageTailOptions) => {
      const end = source.length - offset;
      const events = source.slice(Math.max(0, end - maxMessages), end).map((event, index) => ({
        event,
        eventSeq: index,
        seq: index,
      }));
      scanned += events.length;
      return {
        events,
        totalMessages: source.length,
        scannedMessages: events.length,
        newestContiguousEventCount: events.length,
        serializedBytes: 0,
        snapshot: { indexedSeq: source.length },
      };
    };
    const result = readRecentTranscriptConversationText(readPage, {
      includeTurnIdentity: true,
      candidateMessageIds: ["target"],
    });
    expect(result.map((entry) => entry.text)).toEqual(expectedText);
    expect(scanned).toBeLessThanOrEqual(10_000);
  },
);

it.each([0, 1])(
  "does not bridge an oversized user barrier (%s newest contiguous rows)",
  (newestContiguousEventCount) => {
    const result = readRecentTranscriptConversationText(
      () => ({
        // The bounded reader omitted an oversized unrelated user between these
        // rows; older sparse payloads are not contiguous completion evidence.
        events: [
          {
            event: {
              type: "message",
              id: "target-row",
              message: {
                role: "user",
                content: "unanswered candidate",
                __openclaw: { transport: { messageId: "target" } },
              },
            },
            eventSeq: 1,
            seq: 1,
          },
          {
            event: {
              type: "message",
              id: "unrelated-final",
              message: { role: "assistant", content: "unrelated final", stopReason: "stop" },
            },
            eventSeq: newestContiguousEventCount === 0 ? 2 : 3,
            seq: newestContiguousEventCount === 0 ? 2 : 3,
          },
        ],
        totalMessages: 3,
        scannedMessages: 3,
        newestContiguousEventCount,
        serializedBytes: 1_000,
        snapshot: { indexedSeq: 3 },
      }),
      { includeTurnIdentity: true, candidateMessageIds: ["target"] },
    );
    expect(result.map((entry) => entry.text)).toEqual(
      newestContiguousEventCount === 0 ? [] : ["unrelated final"],
    );
  },
);

it("shares the 64 MiB candidate budget across contiguous pages", () => {
  const requestedBytes: number[] = [];
  const result = readRecentTranscriptConversationText(
    ({ maxBytes, offset }) => {
      requestedBytes.push(maxBytes);
      // Fixed source-page byte reports exercise budget accounting, not SQLite
      // allocation or decoding. The missing candidate would otherwise keep paging.
      expect(requestedBytes.length).toBeLessThanOrEqual(2);
      const events = Array.from({ length: 250 }, (_, index) => ({
        event: { message: { role: "toolResult", content: "activity" } },
        eventSeq: offset + index,
        seq: offset + index,
      }));
      return {
        events,
        totalMessages: 1_000,
        scannedMessages: events.length,
        newestContiguousEventCount: events.length,
        serializedBytes: 32 * 1024 * 1024,
        snapshot: { indexedSeq: 1_000 },
      };
    },
    { includeTurnIdentity: true, candidateMessageIds: ["missing"] },
  );
  expect(requestedBytes).toEqual([64 * 1024 * 1024, 32 * 1024 * 1024]);
  expect(result).toEqual([]);
});
