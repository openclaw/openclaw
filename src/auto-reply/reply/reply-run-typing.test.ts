import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { notifyReplyRunInputIncluded } from "./reply-run-typing.js";

describe("confirmed input feedback ownership", () => {
  it("keeps the old owner completion separate from a same-key successor and final delivery", async () => {
    const key = "feedback:owner-successor";
    const old = createReplyOperation({
      sessionKey: key,
      sessionId: "session-old",
      resetTriggered: false,
    });
    old.setPhase("running");
    const oldIncluded = vi.fn();
    const oldFinalDelivery = createDeferred();
    let successor: ReturnType<typeof createReplyOperation> | undefined;
    try {
      notifyReplyRunInputIncluded(old, { onAdopted() {}, onRunIncluded: oldIncluded });
      const oldRun = oldIncluded.mock.calls[0]?.[0];
      const oldSettled = vi.fn();
      const completion = oldRun.completion.then(oldSettled);
      old.completeWithAfterClearBarrier(oldFinalDelivery.promise);
      await Promise.resolve();
      expect(oldSettled).not.toHaveBeenCalled();

      successor = createReplyOperation({
        sessionKey: key,
        sessionId: "session-new",
        resetTriggered: false,
      });
      successor.setPhase("running");
      const newIncluded = vi.fn();
      notifyReplyRunInputIncluded(successor, { onAdopted() {}, onRunIncluded: newIncluded });
      const newRun = newIncluded.mock.calls[0]?.[0];
      expect(newRun.runId).not.toBe(oldRun.runId);
      expect(newRun.completion).not.toBe(oldRun.completion);
      const newSettled = vi.fn();
      const newCompletion = newRun.completion.then(newSettled);
      oldFinalDelivery.resolve();
      await completion;
      expect(oldSettled).toHaveBeenCalledOnce();
      expect(newSettled).not.toHaveBeenCalled();
      expect(successor.result).toBeNull();
      successor.complete();
      await newCompletion;
      expect(newSettled).toHaveBeenCalledOnce();
    } finally {
      oldFinalDelivery.resolve();
      old.complete();
      successor?.complete();
    }
  });

  it("contains a feedback error while retaining stable identity for the continuing run", () => {
    const operation = createReplyOperation({
      sessionKey: "feedback:observer-error",
      sessionId: "session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const failing = vi.fn(() => {
      throw new Error("reaction API failed");
    });
    const later = vi.fn();
    const laterLifecycle = { onAdopted() {}, onRunIncluded: later };
    try {
      expect(() =>
        notifyReplyRunInputIncluded(operation, { onAdopted() {}, onRunIncluded: failing }),
      ).not.toThrow();
      notifyReplyRunInputIncluded(operation, laterLifecycle);
      notifyReplyRunInputIncluded(operation, laterLifecycle);
      notifyReplyRunInputIncluded(operation, laterLifecycle);
      expect(failing).toHaveBeenCalledOnce();
      expect(later).toHaveBeenCalledOnce();
      expect(later.mock.calls[0]).toEqual(failing.mock.calls[0]);
      expect(operation.result).toBeNull();
      operation.complete();
      notifyReplyRunInputIncluded(operation, { onAdopted() {}, onRunIncluded: later });
      expect(later).toHaveBeenCalledOnce();
    } finally {
      operation.complete();
    }
  });
});
