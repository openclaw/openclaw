import { describe, expect, it } from "vitest";
import { computeHistoryCursor, enforceChatHistoryFinalBudget } from "./chat.js";

describe("computeHistoryCursor", () => {
  it("returns cursor=0 and hasMore=false when start=0 and no capping occurred", () => {
    expect(computeHistoryCursor({ start: 0, slicedLength: 5, boundedLength: 5 })).toEqual({
      cursor: 0,
      hasMore: false,
    });
  });

  it("returns cursor=start and hasMore=true when start>0 and no capping occurred", () => {
    expect(computeHistoryCursor({ start: 10, slicedLength: 5, boundedLength: 5 })).toEqual({
      cursor: 10,
      hasMore: true,
    });
  });

  it("accounts for items dropped from front by byte-capping", () => {
    // sliced had 5 items, capping kept only last 3 → dropped 2 from front
    expect(computeHistoryCursor({ start: 0, slicedLength: 5, boundedLength: 3 })).toEqual({
      cursor: 2,
      hasMore: true,
    });
  });

  it("combines start offset with front-dropped items", () => {
    // start=10, sliced 5 items, capping kept 3 → cursor = 10 + 2 = 12
    expect(computeHistoryCursor({ start: 10, slicedLength: 5, boundedLength: 3 })).toEqual({
      cursor: 12,
      hasMore: true,
    });
  });

  it("treats boundedLength=0 as droppedFromFront=0 (extreme fallback kept no messages)", () => {
    // When bounded is empty the cursor should point to start, not start+slicedLength.
    expect(computeHistoryCursor({ start: 0, slicedLength: 5, boundedLength: 0 })).toEqual({
      cursor: 0,
      hasMore: false,
    });
  });

  it("returns hasMore=false only when cursor is exactly 0", () => {
    expect(computeHistoryCursor({ start: 1, slicedLength: 5, boundedLength: 5 }).hasMore).toBe(
      true,
    );
    expect(computeHistoryCursor({ start: 0, slicedLength: 5, boundedLength: 5 }).hasMore).toBe(
      false,
    );
  });
});

describe("enforceChatHistoryFinalBudget", () => {
  function makeMessages(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `message-${i}`);
  }

  it("returns empty array unchanged with placeholderCount=0", () => {
    const result = enforceChatHistoryFinalBudget({ messages: [], maxBytes: 100 });
    expect(result).toEqual({ messages: [], placeholderCount: 0 });
  });

  it("returns all messages when total size is within budget", () => {
    const msgs = makeMessages(3);
    const budget = JSON.stringify(msgs).length + 100;
    const result = enforceChatHistoryFinalBudget({ messages: msgs, maxBytes: budget });
    expect(result.messages).toEqual(msgs);
    expect(result.placeholderCount).toBe(0);
  });

  it("keeps only the last message when total exceeds budget but last fits", () => {
    const msgs = makeMessages(10);
    // Budget just large enough for the last item alone
    const lastBytes = JSON.stringify([msgs[msgs.length - 1]]).length;
    const result = enforceChatHistoryFinalBudget({ messages: msgs, maxBytes: lastBytes });
    expect(result.messages).toEqual([msgs[msgs.length - 1]]);
    expect(result.placeholderCount).toBe(0);
  });

  it("returns empty array when even the last message does not fit", () => {
    const msgs = ["this message is definitely too long for the tiny budget"];
    const result = enforceChatHistoryFinalBudget({ messages: msgs, maxBytes: 2 });
    expect(result.messages).toEqual([]);
    expect(result.placeholderCount).toBe(0);
  });
});
