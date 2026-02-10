import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecovering,
  clearRecoveringAndFlush,
  getQueuedCount,
  isRecovering,
  queueDelivery,
  resetRecoveryStateForTest,
  setFlushHandler,
  setRecovering,
} from "./recovery-state.js";

const RECOVERY_WINDOW_MS = 30_000;

const mockDeliveryParams = {
  target: "discord:channel:123",
  replies: [{ text: "hello" }],
  token: "token",
  accountId: "test-account",
  runtime: { log: () => {}, error: () => {} },
  textLimit: 2000,
};

describe("recovery-state", () => {
  const accountId = "test-recovery";

  beforeEach(() => {
    vi.useFakeTimers();
    resetRecoveryStateForTest();
  });

  afterEach(() => {
    resetRecoveryStateForTest();
    vi.useRealTimers();
  });

  describe("setRecovering / isRecovering", () => {
    it("marks account as recovering", () => {
      setRecovering(accountId);
      expect(isRecovering(accountId)).toBe(true);
    });

    it("returns false for unknown account", () => {
      expect(isRecovering("unknown")).toBe(false);
    });

    it("expires recovery after window", () => {
      setRecovering(accountId);
      expect(isRecovering(accountId)).toBe(true);

      vi.advanceTimersByTime(RECOVERY_WINDOW_MS);

      expect(isRecovering(accountId)).toBe(false);
    });

    it("clears queue when recovery expires", () => {
      setRecovering(accountId);
      queueDelivery(accountId, { ...mockDeliveryParams, accountId });
      expect(getQueuedCount(accountId)).toBe(1);

      vi.advanceTimersByTime(RECOVERY_WINDOW_MS);
      isRecovering(accountId);

      expect(getQueuedCount(accountId)).toBe(0);
    });
  });

  describe("queueDelivery", () => {
    it("queues only when recovering", () => {
      expect(queueDelivery(accountId, { ...mockDeliveryParams, accountId })).toBe(false);
      expect(getQueuedCount(accountId)).toBe(0);

      setRecovering(accountId);
      expect(queueDelivery(accountId, { ...mockDeliveryParams, accountId })).toBe(true);
      expect(
        queueDelivery(accountId, {
          ...mockDeliveryParams,
          replies: [{ text: "world" }],
          accountId,
        }),
      ).toBe(true);
      expect(getQueuedCount(accountId)).toBe(2);
    });
  });

  describe("clearRecovering", () => {
    it("returns queued deliveries and clears state", () => {
      setRecovering(accountId);
      queueDelivery(accountId, { ...mockDeliveryParams, accountId });

      const queued = clearRecovering(accountId);

      expect(queued).toHaveLength(1);
      expect(queued[0].target).toBe("discord:channel:123");
      expect(queued[0].replies).toEqual([{ text: "hello" }]);
      expect(isRecovering(accountId)).toBe(false);
      expect(getQueuedCount(accountId)).toBe(0);
    });

    it("returns empty for unknown account", () => {
      expect(clearRecovering("unknown")).toEqual([]);
    });
  });

  describe("clearRecoveringAndFlush", () => {
    it("invokes flush handler with queued deliveries", async () => {
      const flushHandler = vi.fn(async () => {});
      setFlushHandler(accountId, flushHandler);
      setRecovering(accountId);
      queueDelivery(accountId, { ...mockDeliveryParams, accountId });

      const count = await clearRecoveringAndFlush(accountId);

      expect(count).toBe(1);
      expect(flushHandler).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ target: "discord:channel:123" })]),
      );
    });

    it("returns 0 when no queued deliveries", async () => {
      setRecovering(accountId);
      const count = await clearRecoveringAndFlush(accountId);
      expect(count).toBe(0);
    });

    it("returns 0 for unknown account", async () => {
      const count = await clearRecoveringAndFlush("unknown");
      expect(count).toBe(0);
    });
  });

  describe("setFlushHandler", () => {
    it("allows registering handler before any state", () => {
      setFlushHandler(
        accountId,
        vi.fn(async () => {}),
      );
      setRecovering(accountId);
      expect(isRecovering(accountId)).toBe(true);
    });
  });
});
