import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  beginReplyMessageInjectionTarget,
  forceClearReplyOperation,
  ReplyRunSuccessorAdmissionBlockedError,
  replyRunRegistry,
  waitForReplyRunSuccessorAdmission,
} from "./reply-run-registry.js";
import { resolveActiveReplyRunOwnerForSignal } from "./reply-run-registry.state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

const sessionKey = "agent:main:voice-control";

afterEach(() => replyRunRegistry.get(sessionKey)?.complete());

describe("reply run control ownership", () => {
  it.each([false, true])(
    "settles producer handoff before delivery can admit a successor (forced clear=%s)",
    async (forcedClear) => {
      const controller = new AbortController();
      const operation = createTestReplyOperation({
        sessionKey,
        upstreamAbortSignal: controller.signal,
      });
      operation.setPhase("running");
      const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
      const persistence = createDeferred();
      const delivery = createDeferred();
      const started = vi.fn();
      let handoff: Promise<void> | undefined;
      try {
        expect(
          owner?.handoff((producerCompleted) => {
            handoff = producerCompleted.then(async () => {
              started();
              await persistence.promise;
            });
            return handoff;
          }),
        ).toBe(true);

        controller.abort();
        if (forcedClear) {
          expect(forceClearReplyOperation(operation)).toBe(true);
        }
        await Promise.resolve();
        expect(started).not.toHaveBeenCalled();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow();

        operation.completeWithAfterClearBarrier(delivery.promise);
        await Promise.resolve();
        expect(started).toHaveBeenCalledOnce();
        expect(() => createTestReplyOperation({ sessionKey })).toThrow(
          ReplyRunSuccessorAdmissionBlockedError,
        );
        const nextAdmission = waitForReplyRunSuccessorAdmission(operation.key, null);
        persistence.resolve();
        await handoff;
        await expect(nextAdmission).resolves.toMatchObject({ settled: true });

        // Delivery is allowed to depend on a new operation without a settlement cycle.
        const successor = createTestReplyOperation({ sessionKey, sessionId: "successor" });
        successor.complete();
        delivery.resolve();
        await operation.ownerSettlement;
        expect(owner?.handoff(async () => {})).toBe(false);
      } finally {
        persistence.resolve();
        delivery.resolve();
        operation.complete();
        await operation.ownerSettlement;
      }
    },
  );

  it.each(["required", "optional"] as const)(
    "keeps a mismatched input out of a %s reply owner",
    async (terminalReplyExpectation) => {
      const queueMessage = vi.fn(async () => {});
      const operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "session-reply-expectation",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        terminalReplyExpectation,
        cancel: vi.fn(),
        queueMessage,
      });
      operation.setPhase("running");
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
      if (!target) {
        throw new Error("Expected a live message injection target");
      }
      await expect(
        beginReplyMessageInjectionTarget(target, "different input", {
          terminalReplyExpectation:
            terminalReplyExpectation === "required" ? "optional" : "required",
        }).outcome,
      ).resolves.toEqual({ status: "rejected", reason: "reply_expectation_mismatch" });
      expect(queueMessage).not.toHaveBeenCalled();
      await expect(
        beginReplyMessageInjectionTarget(target, "matching input", {
          terminalReplyExpectation,
        }).outcome,
      ).resolves.toEqual({ status: "accepted" });
      expect(queueMessage).toHaveBeenCalledOnce();
    },
  );

  it.each(["key", "sessionId"] as const)(
    "fences retained controls after its %s changes",
    (field) => {
      const controller = new AbortController();
      const operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "original-session",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      try {
        const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
        if (field === "key") {
          operation.updateSessionKey("agent:main:voice-control-rekeyed");
        } else {
          operation.updateSessionId("replacement-session");
        }
        expect(owner?.abort()).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        operation.complete();
      }
    },
  );

  it("controls a queued reply only through its admitted upstream signal", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "queued-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(new AbortController().signal)).toBeUndefined();
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    expect(owner?.sessionId).toBe("queued-session");
    expect(owner?.abort()).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
  });

  it("fences retained controls after same-session replacement", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
    expect(owner?.abort()).toBe(false);
    expect(successor.abortSignal.aborted).toBe(false);
  });
});
