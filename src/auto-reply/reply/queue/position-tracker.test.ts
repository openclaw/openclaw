import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TRACKED_POSITION, QueuePositionTracker } from "./position-tracker.js";
import type { FollowupRun } from "./types.js";

// Mock Slack actions module.
vi.mock("../../../slack/actions.js", () => ({
  reactSlackMessage: vi.fn().mockResolvedValue(undefined),
  removeSlackReaction: vi.fn().mockResolvedValue(undefined),
}));

// Mock runtime to suppress error logging in tests.
vi.mock("../../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn() },
}));

import { reactSlackMessage, removeSlackReaction } from "../../../slack/actions.js";

const mockReact = vi.mocked(reactSlackMessage);
const mockRemove = vi.mocked(removeSlackReaction);

function makeRun(
  overrides: Partial<FollowupRun> & { channelId?: string; ts?: string } = {},
): FollowupRun {
  const channelId = overrides.channelId ?? "C0001";
  const ts = overrides.ts ?? "1234567890.000001";
  return {
    prompt: "hello",
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: channelId,
    messageId: ts,
    originatingAccountId: overrides.originatingAccountId,
    run: {
      agentId: "agent-1",
      agentDir: "/tmp",
      sessionId: "sess-1",
      sessionFile: "/tmp/session",
      workspaceDir: "/tmp",
      config: {} as never,
      provider: "slack",
      model: "test",
      timeoutMs: 30000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function makeNonSlackRun(): FollowupRun {
  return makeRun({ originatingChannel: "telegram" as never });
}

describe("QueuePositionTracker", () => {
  let tracker: QueuePositionTracker;

  beforeEach(() => {
    tracker = new QueuePositionTracker();
    mockReact.mockClear();
    mockRemove.mockClear();
  });

  describe("updateQueuePositions", () => {
    it("adds number reactions for queued Slack messages", async () => {
      const run1 = makeRun({ ts: "1.1" });
      const run2 = makeRun({ ts: "1.2" });

      await tracker.updateQueuePositions([run1, run2]);

      expect(mockReact).toHaveBeenCalledWith("C0001", "1.1", "one", {});
      expect(mockReact).toHaveBeenCalledWith("C0001", "1.2", "two", {});
      expect(mockReact).toHaveBeenCalledTimes(2);
    });

    it("passes accountId when present", async () => {
      const run = makeRun({ ts: "1.1", originatingAccountId: "A99" });

      await tracker.updateQueuePositions([run]);

      expect(mockReact).toHaveBeenCalledWith("C0001", "1.1", "one", { accountId: "A99" });
    });

    it("updates reactions when queue order changes", async () => {
      const run1 = makeRun({ ts: "1.1" });
      const run2 = makeRun({ ts: "1.2" });

      await tracker.updateQueuePositions([run1, run2]);
      mockReact.mockClear();
      mockRemove.mockClear();

      // Swap order.
      await tracker.updateQueuePositions([run2, run1]);

      // run2 was 'two', now should be 'one' — remove 'two', add 'one'.
      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.2", "two", {});
      expect(mockReact).toHaveBeenCalledWith("C0001", "1.2", "one", {});
      // run1 was 'one', now should be 'two' — remove 'one', add 'two'.
      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.1", "one", {});
      expect(mockReact).toHaveBeenCalledWith("C0001", "1.1", "two", {});
    });

    it("removes reaction for items no longer in the queue", async () => {
      const run1 = makeRun({ ts: "1.1" });
      const run2 = makeRun({ ts: "1.2" });

      await tracker.updateQueuePositions([run1, run2]);
      mockReact.mockClear();
      mockRemove.mockClear();

      await tracker.updateQueuePositions([run1]);

      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.2", "two", {});
      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(mockReact).not.toHaveBeenCalled();
    });

    it("does not add a reaction beyond MAX_TRACKED_POSITION", async () => {
      const runs = Array.from({ length: MAX_TRACKED_POSITION + 2 }, (_, i) =>
        makeRun({ ts: `1.${i + 1}` }),
      );

      await tracker.updateQueuePositions(runs);

      // Only MAX_TRACKED_POSITION reactions should be added.
      expect(mockReact).toHaveBeenCalledTimes(MAX_TRACKED_POSITION);
    });

    it("ignores non-Slack messages", async () => {
      const run = makeNonSlackRun();

      await tracker.updateQueuePositions([run]);

      expect(mockReact).not.toHaveBeenCalled();
    });

    it("ignores runs with missing channelId or messageId", async () => {
      const run = makeRun({ channelId: undefined as never, ts: "1.1" });
      run.originatingTo = undefined;

      await tracker.updateQueuePositions([run]);

      expect(mockReact).not.toHaveBeenCalled();
    });
  });

  describe("markAsProcessing / removeProcessingIndicator", () => {
    it("swaps position emoji for hourglass when processing starts", async () => {
      const run = makeRun({ ts: "1.1" });
      await tracker.updateQueuePositions([run]);
      mockReact.mockClear();
      mockRemove.mockClear();

      await tracker.markAsProcessing(run);

      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.1", "one", {});
      expect(mockReact).toHaveBeenCalledWith("C0001", "1.1", "hourglass_flowing_sand", {});
    });

    it("removes hourglass after processing completes", async () => {
      const run = makeRun({ ts: "1.1" });
      await tracker.updateQueuePositions([run]);
      await tracker.markAsProcessing(run);
      mockReact.mockClear();
      mockRemove.mockClear();

      await tracker.removeProcessingIndicator(run);

      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.1", "hourglass_flowing_sand", {});
      expect(mockReact).not.toHaveBeenCalled();
    });

    it("does nothing for non-Slack runs in markAsProcessing", async () => {
      await tracker.markAsProcessing(makeNonSlackRun());
      expect(mockReact).not.toHaveBeenCalled();
    });

    it("does nothing for non-Slack runs in removeProcessingIndicator", async () => {
      await tracker.removeProcessingIndicator(makeNonSlackRun());
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });

  describe("clearAll", () => {
    it("removes all tracked reactions using the stored accountId", async () => {
      const run1 = makeRun({ ts: "1.1", originatingAccountId: "A1" });
      const run2 = makeRun({ ts: "1.2", originatingAccountId: "A2" });

      await tracker.updateQueuePositions([run1, run2]);
      mockReact.mockClear();
      mockRemove.mockClear();

      await tracker.clearAll();

      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.1", "one", { accountId: "A1" });
      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.2", "two", { accountId: "A2" });
      expect(mockRemove).toHaveBeenCalledTimes(2);
    });

    it("removes nothing when tracker is empty", async () => {
      await tracker.clearAll();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("clears state so subsequent calls are no-ops", async () => {
      const run = makeRun({ ts: "1.1" });
      await tracker.updateQueuePositions([run]);
      await tracker.clearAll();
      mockRemove.mockClear();

      await tracker.clearAll();

      expect(mockRemove).not.toHaveBeenCalled();
    });
  });

  describe("clearQueuePositions", () => {
    it("removes reactions only for the specified items", async () => {
      const run1 = makeRun({ ts: "1.1" });
      const run2 = makeRun({ ts: "1.2" });

      await tracker.updateQueuePositions([run1, run2]);
      mockReact.mockClear();
      mockRemove.mockClear();

      // Clear only run1 — run2 should be untouched.
      await tracker.clearQueuePositions([run1]);

      expect(mockRemove).toHaveBeenCalledWith("C0001", "1.1", "one", {});
      expect(mockRemove).toHaveBeenCalledTimes(1);
    });

    it("ignores non-Slack items", async () => {
      await tracker.clearQueuePositions([makeNonSlackRun()]);
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });
});
