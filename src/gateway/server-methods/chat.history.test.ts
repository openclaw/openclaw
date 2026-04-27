import { describe, expect, it } from "vitest";
import { computeHistoryCursor, enforceChatHistoryFinalBudget } from "./chat.js";

describe("computeHistoryCursor", () => {
  it("returns cursor=0 and hasMore=false when firstRawIndex=0", () => {
    expect(computeHistoryCursor({ firstRawIndex: 0 })).toEqual({
      cursor: 0,
      hasMore: false,
    });
  });

  it("returns cursor=firstRawIndex and hasMore=true when firstRawIndex>0", () => {
    expect(computeHistoryCursor({ firstRawIndex: 10 })).toEqual({
      cursor: 10,
      hasMore: true,
    });
  });

  it("reflects the raw index of the first surviving message after byte-capping", () => {
    // First surviving message is at raw index 3 (two NO_REPLY messages dropped before it)
    expect(computeHistoryCursor({ firstRawIndex: 3 })).toEqual({
      cursor: 3,
      hasMore: true,
    });
  });

  it("returns hasMore=false only when cursor is exactly 0", () => {
    expect(computeHistoryCursor({ firstRawIndex: 1 }).hasMore).toBe(true);
    expect(computeHistoryCursor({ firstRawIndex: 0 }).hasMore).toBe(false);
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
