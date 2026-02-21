import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFollowUpForTest, recordGroupReply } from "./group-gating.js";

/**
 * Tests for the group follow-up window feature.
 *
 * After the bot replies to a sender in a group, subsequent messages from that
 * same sender within the configured window are treated as implicit mentions so
 * the conversation can continue without requiring another @mention.
 */
describe("group follow-up window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset internal tracker state between tests by re-importing is not
    // straightforward in ESM; instead we rely on the exported test helper.
    isFollowUpForTest.reset();
  });

  const GROUP = "120363000000000001@g.us";
  const ALICE = "+15550000001";
  const BOB = "+15550000002";
  const WINDOW = 5 * 60 * 1000; // 5 min

  it("returns true for the same sender within the window", () => {
    recordGroupReply(GROUP, ALICE);
    expect(isFollowUpForTest.check(GROUP, ALICE, WINDOW)).toBe(true);
  });

  it("returns false for the same sender after the window expires", () => {
    recordGroupReply(GROUP, ALICE);
    vi.advanceTimersByTime(WINDOW + 1);
    expect(isFollowUpForTest.check(GROUP, ALICE, WINDOW)).toBe(false);
  });

  it("returns false for a different sender within the window", () => {
    recordGroupReply(GROUP, ALICE);
    expect(isFollowUpForTest.check(GROUP, BOB, WINDOW)).toBe(false);
  });

  it("tracks multiple senders per group independently", () => {
    recordGroupReply(GROUP, ALICE);
    recordGroupReply(GROUP, BOB);

    expect(isFollowUpForTest.check(GROUP, ALICE, WINDOW)).toBe(true);
    expect(isFollowUpForTest.check(GROUP, BOB, WINDOW)).toBe(true);
  });

  it("expires each sender independently", () => {
    recordGroupReply(GROUP, ALICE);
    vi.advanceTimersByTime(WINDOW / 2);
    recordGroupReply(GROUP, BOB);
    vi.advanceTimersByTime(WINDOW / 2 + 1);

    // ALICE's window has expired; BOB's has not.
    expect(isFollowUpForTest.check(GROUP, ALICE, WINDOW)).toBe(false);
    expect(isFollowUpForTest.check(GROUP, BOB, WINDOW)).toBe(true);
  });

  it("returns false when windowMs is 0 (feature disabled)", () => {
    recordGroupReply(GROUP, ALICE);
    expect(isFollowUpForTest.check(GROUP, ALICE, 0)).toBe(false);
  });

  it("returns false when sender is undefined", () => {
    recordGroupReply(GROUP, ALICE);
    expect(isFollowUpForTest.check(GROUP, undefined, WINDOW)).toBe(false);
  });

  it("does not affect other groups", () => {
    const OTHER = "120363000000000002@g.us";
    recordGroupReply(GROUP, ALICE);
    expect(isFollowUpForTest.check(OTHER, ALICE, WINDOW)).toBe(false);
  });
});
