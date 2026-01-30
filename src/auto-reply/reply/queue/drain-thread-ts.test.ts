import { describe, expect, it } from "vitest";
import { hasCrossChannelItems } from "../../../utils/queue-helpers.js";

/**
 * Tests for PR #4413: thread_ts null check fix.
 *
 * The queue drain logic uses `hasCrossChannelItems` with a key resolver that
 * includes threadId in the routing key. Previously it used
 * `typeof threadId === "number"` which silently ignored string thread IDs
 * (e.g. Slack's `thread_ts = "1706000000.000100"`). The fix uses
 * `threadId != null` to handle both number and string thread IDs.
 */

interface FakeQueueItem {
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}

/** Mirrors the resolveKey callback from drain.ts (post-fix version). */
function resolveKey(item: FakeQueueItem) {
  const channel = item.originatingChannel;
  const to = item.originatingTo;
  const accountId = item.originatingAccountId;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && threadId == null) {
    return {};
  }
  // isRoutableChannel simplified: just check truthy for test purposes
  if (!channel || !to) {
    return { cross: true };
  }
  const threadKey = threadId != null ? String(threadId) : "";
  return {
    key: [channel, to, accountId || "", threadKey].join("|"),
  };
}

/** The OLD (buggy) resolveKey that used typeof === "number". */
function resolveKeyBuggy(item: FakeQueueItem) {
  const channel = item.originatingChannel;
  const to = item.originatingTo;
  const accountId = item.originatingAccountId;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && typeof threadId !== "number") {
    return {};
  }
  if (!channel || !to) {
    return { cross: true };
  }
  const threadKey = typeof threadId === "number" ? String(threadId) : "";
  return {
    key: [channel, to, accountId || "", threadKey].join("|"),
  };
}

describe("thread_ts null check (PR #4413)", () => {
  describe("resolveKey with string thread IDs (Slack thread_ts)", () => {
    const slackItem: FakeQueueItem = {
      originatingChannel: "slack",
      originatingTo: "C123",
      originatingAccountId: "T456",
      originatingThreadId: "1706000000.000100",
    };

    it("includes string threadId in key (fixed)", () => {
      const result = resolveKey(slackItem);
      expect(result.key).toBe("slack|C123|T456|1706000000.000100");
    });

    it("old code drops string threadId from key (bug)", () => {
      const result = resolveKeyBuggy(slackItem);
      // Bug: string threadId is ignored, threadKey becomes ""
      expect(result.key).toBe("slack|C123|T456|");
    });

    it("distinguishes messages in different Slack threads", () => {
      const items: FakeQueueItem[] = [
        { ...slackItem, originatingThreadId: "1706000000.000100" },
        { ...slackItem, originatingThreadId: "1706000000.000200" },
      ];
      expect(hasCrossChannelItems(items, resolveKey)).toBe(true);
    });

    it("old code collapses different Slack threads into same key (bug)", () => {
      const items: FakeQueueItem[] = [
        { ...slackItem, originatingThreadId: "1706000000.000100" },
        { ...slackItem, originatingThreadId: "1706000000.000200" },
      ];
      // Bug: both get key "slack|C123|T456|" so they look same-channel
      expect(hasCrossChannelItems(items, resolveKeyBuggy)).toBe(false);
    });
  });

  describe("resolveKey with numeric thread IDs", () => {
    it("includes numeric threadId in key", () => {
      const result = resolveKey({
        originatingChannel: "discord",
        originatingTo: "guild123",
        originatingThreadId: 42,
      });
      expect(result.key).toBe("discord|guild123||42");
    });

    it("old code also handles numeric threadId (was already working)", () => {
      const result = resolveKeyBuggy({
        originatingChannel: "discord",
        originatingTo: "guild123",
        originatingThreadId: 42,
      });
      expect(result.key).toBe("discord|guild123||42");
    });
  });

  describe("resolveKey with null/undefined threadId", () => {
    it("returns empty object when all fields are empty", () => {
      expect(resolveKey({})).toEqual({});
    });

    it("uses empty string for threadKey when threadId is undefined", () => {
      const result = resolveKey({
        originatingChannel: "slack",
        originatingTo: "C123",
      });
      expect(result.key).toBe("slack|C123||");
    });

    it("uses empty string for threadKey when threadId is null-ish", () => {
      const result = resolveKey({
        originatingChannel: "slack",
        originatingTo: "C123",
        originatingThreadId: undefined,
      });
      expect(result.key).toBe("slack|C123||");
    });
  });

  describe("finding originatingThreadId in items (second fix site)", () => {
    /**
     * The drain also does:
     *   items.find(i => i.originatingThreadId != null)?.originatingThreadId
     * Previously: items.find(i => typeof i.originatingThreadId === "number")
     */
    const findThreadId = (items: FakeQueueItem[]) =>
      items.find((i) => i.originatingThreadId != null)?.originatingThreadId;

    const findThreadIdBuggy = (items: FakeQueueItem[]) =>
      items.find((i) => typeof i.originatingThreadId === "number")?.originatingThreadId;

    it("finds string thread ID (fixed)", () => {
      const items: FakeQueueItem[] = [
        { originatingChannel: "slack" },
        { originatingChannel: "slack", originatingThreadId: "1706000000.000100" },
      ];
      expect(findThreadId(items)).toBe("1706000000.000100");
    });

    it("old code misses string thread ID (bug)", () => {
      const items: FakeQueueItem[] = [
        { originatingChannel: "slack" },
        { originatingChannel: "slack", originatingThreadId: "1706000000.000100" },
      ];
      expect(findThreadIdBuggy(items)).toBeUndefined();
    });

    it("finds numeric thread ID", () => {
      const items: FakeQueueItem[] = [
        { originatingChannel: "discord" },
        { originatingChannel: "discord", originatingThreadId: 99 },
      ];
      expect(findThreadId(items)).toBe(99);
      expect(findThreadIdBuggy(items)).toBe(99);
    });

    it("returns undefined when no items have threadId", () => {
      const items: FakeQueueItem[] = [
        { originatingChannel: "slack" },
        { originatingChannel: "slack" },
      ];
      expect(findThreadId(items)).toBeUndefined();
    });
  });
});
