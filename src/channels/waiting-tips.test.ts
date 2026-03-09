import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createWaitingTipController,
  formatWaitingMessage,
  getBuiltinTips,
  getRandomTip,
} from "./waiting-tips.js";

describe("waiting-tips", () => {
  describe("getBuiltinTips", () => {
    it("returns 74 built-in tips", () => {
      expect(getBuiltinTips().length).toBe(74);
    });
  });

  describe("getRandomTip", () => {
    it("returns a non-empty string", () => {
      const tip = getRandomTip();
      expect(tip).toBeTruthy();
      expect(typeof tip).toBe("string");
    });

    it("includes custom tips when provided", () => {
      const custom = ["My custom tip\n我的自定义提示"];
      // With many iterations, a custom tip should appear at least once
      const results = new Set<string>();
      for (let i = 0; i < 200; i++) {
        results.add(getRandomTip(custom));
      }
      expect(results.has(custom[0])).toBe(true);
    });
  });

  describe("formatWaitingMessage", () => {
    it("formats inline style", () => {
      const msg = formatWaitingMessage("Test tip\n测试提示");
      expect(msg).toContain("⏳");
      expect(msg).toContain("💡");
      expect(msg).toContain("Test tip");
    });

    it("formats card style with borders", () => {
      const msg = formatWaitingMessage("Test tip\n测试提示", "card");
      expect(msg).toContain("━━━━");
      expect(msg).toContain("Received");
      expect(msg).toContain("Test tip");
    });
  });

  describe("createWaitingTipController", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does nothing when disabled", async () => {
      const sendTip = vi.fn();
      const controller = createWaitingTipController({
        enabled: false,
        adapter: { sendTip },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendTip).not.toHaveBeenCalled();
    });

    it("sends tip after minWaitMs", async () => {
      const sendTip = vi.fn().mockResolvedValue(42);
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip },
        config: { minWaitMs: 2000 },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1999);
      expect(sendTip).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTip).toHaveBeenCalledOnce();
      const [text] = sendTip.mock.calls[0] as [string];
      expect(text).toContain("⏳");
      expect(text).toContain("💡");
    });

    it("does not send tip if cancelled before minWaitMs", async () => {
      const sendTip = vi.fn().mockResolvedValue(42);
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip },
        config: { minWaitMs: 2000 },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1500);
      controller.cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendTip).not.toHaveBeenCalled();
    });

    it("deletes tip on cleanup when deleteAfterReply is true", async () => {
      const sendTip = vi.fn().mockResolvedValue(42);
      const deleteTip = vi.fn().mockResolvedValue(undefined);
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip, deleteTip },
        config: { minWaitMs: 0, deleteAfterReply: true },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1);
      await controller.cleanup();
      expect(deleteTip).toHaveBeenCalledWith(42);
    });

    it("does not delete tip when deleteAfterReply is false", async () => {
      const sendTip = vi.fn().mockResolvedValue(42);
      const deleteTip = vi.fn().mockResolvedValue(undefined);
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip, deleteTip },
        config: { minWaitMs: 0, deleteAfterReply: false },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1);
      await controller.cleanup();
      expect(deleteTip).not.toHaveBeenCalled();
    });

    it("handles sendTip errors gracefully", async () => {
      const onError = vi.fn();
      const sendTip = vi.fn().mockRejectedValue(new Error("network error"));
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip },
        config: { minWaitMs: 0 },
        onError,
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1);
      await controller.cleanup();
      expect(onError).toHaveBeenCalledOnce();
    });

    it("handles deleteTip errors gracefully", async () => {
      const onError = vi.fn();
      const sendTip = vi.fn().mockResolvedValue(42);
      const deleteTip = vi.fn().mockRejectedValue(new Error("delete failed"));
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip, deleteTip },
        config: { minWaitMs: 0 },
        onError,
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1);
      await controller.cleanup();
      expect(onError).toHaveBeenCalledOnce();
    });

    it("uses default minWaitMs of 2000", async () => {
      const sendTip = vi.fn().mockResolvedValue(42);
      const controller = createWaitingTipController({
        enabled: true,
        adapter: { sendTip },
      });
      controller.scheduleShow();
      await vi.advanceTimersByTimeAsync(1999);
      expect(sendTip).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTip).toHaveBeenCalledOnce();
    });
  });
});
