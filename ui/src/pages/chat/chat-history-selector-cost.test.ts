import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import { prepareChatHistoryAdmission } from "./chat-history-page-preparation.ts";
import { prepareChatHistorySegment, selectChatHistoryResidency } from "./chat-history-window.ts";

function row(seq: number) {
  return {
    role: "assistant",
    content: "history ".repeat(64),
    __openclaw: { id: `source-${seq}`, seq, runId: `run-${seq}` },
  };
}

it.each(["older", "newer"] as const)(
  "bounds selector work while trimming an 800-source %s merge with 20 lifecycle pins",
  (direction) => {
    const messages = Array.from({ length: 800 }, (_, index) => row(index + 1));
    const pinned = direction === "older" ? messages.slice(-20) : messages.slice(0, 20);
    let projection = createSessionProjection({}, pinned);
    for (const message of pinned) {
      projection = reduceSessionProjection(projection, {
        type: "runDelta",
        runId: message["__openclaw"].runId,
        message,
      });
    }
    const pins = reduceSessionProjection(projection, {
      type: "residencyChanged",
      messages: [],
    }).messages;
    expect(pins).toEqual(pinned);
    let metadataReads = 0;
    for (const message of pinned) {
      const metadata = message["__openclaw"];
      Object.defineProperty(message, "__openclaw", {
        enumerable: true,
        configurable: true,
        get() {
          metadataReads++;
          return metadata;
        },
      });
    }
    const segment = prepareChatHistorySegment(
      messages,
      { hasMore: true, olderCursor: "opaque-before" },
      "opaque-after",
    );
    const sources = segment.sources;
    const copies = vi.spyOn(sources, "slice");
    metadataReads = 0; // Body weights and original packet facts are already prepared.
    try {
      const selected = selectChatHistoryResidency(
        messages,
        {
          hasMore: true,
          olderCursor: "opaque-before",
          hasNewer: true,
          newerCursor: "opaque-after",
          segments: [segment],
        },
        direction,
        direction === "older" ? "id:source-1" : "id:source-800",
        [],
        prepareChatHistoryAdmission(messages, [segment], [], pins),
      );
      const work = { metadataReads, sourceCopies: copies.mock.calls.length };
      const expected = direction === "older" ? messages.slice(0, 380) : messages.slice(-380);
      expect(selected.messages).toEqual(expected);
      expect(selected.withinBudget).toBe(true);
      expect(selected.pagination).toEqual({
        hasMore: true,
        ...(direction === "older" ? { olderCursor: "opaque-before" } : { needsBoundary: true }),
        hasNewer: true,
        ...(direction === "newer" ? { newerCursor: "opaque-after" } : { needsNewerBoundary: true }),
        segments: [
          {
            ...segment,
            sources: expected.map((message) => `id:source-${message["__openclaw"].seq}`),
            boundedPacket: undefined,
            ...(direction === "older" ? { newerCursor: undefined } : { olderCursor: undefined }),
          },
        ],
      });
      expect(segment.sources).toBe(sources);
      expect(sources).toHaveLength(800);
      // Work follows input occurrences, not the number of successive interior cuts.
      expect({
        metadataBounded: work.metadataReads <= pins.length * 32,
        copiesBounded: work.sourceCopies <= 1,
      }).toEqual({ metadataBounded: true, copiesBounded: true });
    } finally {
      copies.mockRestore();
    }
  },
);

it.each(["older", "newer"] as const)(
  "charges a shared source until its last %s coverage and then uncovers its pin",
  (direction) => {
    const messages = Array.from({ length: 800 }, (_, index) => row(index + 1));
    const split = direction === "older" ? 599 : 200;
    const left = prepareChatHistorySegment(
      messages.slice(0, split + 1),
      { hasMore: true, olderCursor: "opaque-before" },
      "left-after",
    );
    const right = prepareChatHistorySegment(
      messages.slice(split),
      { hasMore: true, olderCursor: "right-before" },
      "opaque-after",
    );
    const selected = selectChatHistoryResidency(
      messages,
      {
        hasMore: true,
        olderCursor: "opaque-before",
        hasNewer: true,
        newerCursor: "opaque-after",
        segments: [left, right],
      },
      direction,
      direction === "older" ? "id:source-1" : "id:source-800",
      [],
      prepareChatHistoryAdmission(messages, [left, right], [], [messages[split]]),
    );
    const expected = direction === "older" ? messages.slice(0, 399) : messages.slice(-399);
    expect(selected.messages).toEqual(expected);
    expect(selected.withinBudget).toBe(true);
    expect(selected.pagination.segments).toHaveLength(1);
    expect(selected.pagination).toMatchObject(
      direction === "older"
        ? { olderCursor: "opaque-before", needsNewerBoundary: true }
        : { newerCursor: "opaque-after", needsBoundary: true },
    );
    expect(left.sources.at(-1)).toBe(right.sources[0]);
    expect(left.sources).toHaveLength(split + 1);
    expect(right.sources).toHaveLength(800 - split);
  },
);

it("unions repeated pin occurrences with complete source fragments without deduplication", () => {
  const repeated = row(1);
  const fragments = [repeated, repeated, repeated, { ...row(1), content: "second fragment" }];
  const neighbors = Array.from({ length: 400 }, (_, index) => row(index + 2));
  const messages = [...fragments, ...neighbors];
  const segment = prepareChatHistorySegment(messages, { hasMore: false });
  const selected = selectChatHistoryResidency(
    messages,
    { hasMore: false, segments: [segment] },
    "older",
    "id:source-1",
    [],
    prepareChatHistoryAdmission(messages, [segment], [], [repeated, repeated, repeated, repeated]),
  );
  expect(selected.withinBudget).toBe(true);
  expect(selected.messages).toEqual([...fragments, ...neighbors.slice(0, 395)]);
  expect(selected.messages.filter((message) => message === repeated)).toHaveLength(3);
  expect(selected.pagination).toMatchObject({
    hasMore: false,
    hasNewer: true,
    needsNewerBoundary: true,
  });
});

it.each([false, true])(
  "keeps signed pin credit correct for an exempt source (retired=%s)",
  (retired) => {
    const repeated = row(1);
    const fragments = [
      repeated,
      repeated,
      ...Array.from({ length: 399 }, (_, index) => ({ ...row(1), content: `fragment-${index}` })),
    ];
    const neighbors = Array.from({ length: retired ? 404 : 399 }, (_, index) => row(index + 2));
    const local = { role: "system", content: "newest local outcome" };
    const messages = [...fragments, ...neighbors, ...(retired ? [] : [local])];
    const segment = prepareChatHistorySegment(messages, { hasMore: false });
    const selected = selectChatHistoryResidency(
      messages,
      { hasMore: false, intrinsicSource: "id:source-1", segments: [segment] },
      "newer",
      null,
      retired ? [] : [local],
      prepareChatHistoryAdmission(messages, [segment], [], [repeated, repeated]),
    );
    expect(selected.withinBudget).toBe(true);
    // Removing the exempt source loses its two-occurrence pin credit: 398, not400,
    // ordinary neighbors fit. While covered, negative credit cancels their base cost.
    expect(selected.messages).toEqual(retired ? neighbors.slice(6) : messages);
    if (retired) {
      expect(selected.pagination).not.toHaveProperty("intrinsicSource");
      expect(selected.pagination).toMatchObject({ needsBoundary: true });
    } else {
      expect(selected.pagination.segments?.[0]).toBe(segment);
      expect(selected.pagination.intrinsicSource).toBe("id:source-1");
    }
  },
);

it("preserves untouched segment and source-array identity with their opaque edges", () => {
  const messages = Array.from({ length: 100 }, (_, index) => row(index + 1));
  const left = prepareChatHistorySegment(
    messages.slice(0, 50),
    { hasMore: true, olderCursor: "opaque-before" },
    "left-after",
  );
  const right = prepareChatHistorySegment(
    messages.slice(49),
    { hasMore: true, olderCursor: "right-before" },
    "opaque-after",
  );
  const selected = selectChatHistoryResidency(
    messages,
    {
      hasMore: true,
      olderCursor: "opaque-before",
      hasNewer: true,
      newerCursor: "opaque-after",
      segments: [left, right],
    },
    "older",
    "id:source-50",
  );
  expect(selected.messages).toEqual(messages);
  expect(selected.withinBudget).toBe(true);
  expect(selected.pagination).toMatchObject({
    olderCursor: "opaque-before",
    newerCursor: "opaque-after",
  });
  expect(selected.pagination.segments?.[0]).toBe(left);
  expect(selected.pagination.segments?.[1]).toBe(right);
  expect(selected.pagination.segments?.[0]?.sources).toBe(left.sources);
  expect(selected.pagination.segments?.[1]?.sources).toBe(right.sources);
});
