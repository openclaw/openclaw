import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../sessions/session-controller.barriers.js";
import {
  ReplyRunSuccessorAdmissionBlockedError,
  waitForReplyRunSuccessorAdmission,
  createReplyOperation,
  getSessionControllerOperation,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import {
  createTestReplyOperation,
  queueReplyMessageInjectionTarget,
} from "./reply-run-registry.test-helpers.js";

const sessionKey = "agent:main:voice-control";

afterEach(() => getSessionControllerOperation(sessionKey)?.complete());

describe("reply run control ownership", () => {
  it("retains failed admission for the SDK opt-in until completion", async () => {
    const operation = createTestReplyOperation({ sessionKey });
    const settled = vi.fn();
    void operation.ownerSettlement.then(settled);
    operation.setPhase("running");
    operation.retainFailureUntilComplete();
    operation.fail("run_failed", new Error("provider failed"));
    await Promise.resolve();

    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    expect(settled).not.toHaveBeenCalled();
    expect(() => createTestReplyOperation({ sessionKey })).toThrow();

    operation.complete();
    await operation.ownerSettlement;
    expect(settled).toHaveBeenCalledOnce();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    const successor = createTestReplyOperation({ sessionKey, sessionId: "successor" });
    successor.complete();
  });

  it.each([undefined, "message_tool_only"] as const)(
    "preserves source-reply delivery semantics with active mode %s",
    async (sourceReplyDeliveryMode) => {
      const queueMessage = vi.fn(async () => {});
      const operation = createTestReplyOperation({ sessionKey });
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        sourceReplyDeliveryMode,
        queueMessage,
      });
      operation.setPhase("running");
      const target = captureCurrentReplyMessageInjectionTarget(operation.key)!;
      const outcome = await queueReplyMessageInjectionTarget(target, "continue", {
        sourceReplyDeliveryMode: "message_tool_only",
      });

      if (sourceReplyDeliveryMode === "message_tool_only") {
        expect(outcome).toEqual({ status: "accepted" });
        expect(queueMessage).toHaveBeenCalledExactlyOnceWith(
          "continue",
          expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
        );
      } else {
        expect(outcome).toEqual({
          status: "rejected",
          reason: "source_reply_delivery_mode_mismatch",
        });
        expect(queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "settles producer handoff before delivery can admit a successor (cleanup expired=%s)",
    async (cleanupExpired) => {
      const controller = new AbortController();
      const operation = createTestReplyOperation({
        sessionKey,
        upstreamAbortSignal: controller.signal,
      });
      operation.setPhase("running");
      const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
      const persistence = createDeferred();
      const delivery = createDeferred();
      const producerError = new Error("Producer rejected its partial reply");
      const started = vi.fn();
      const ownerSettled = vi.fn();
      void operation.ownerSettlement.then(ownerSettled);
      let handoff: Promise<void> | undefined;
      try {
        expect(
          owner?.handoff((producerCompleted) => {
            handoff = producerCompleted.then(async (error) => {
              expect(error).toBe(producerError);
              started();
              await persistence.promise;
            });
            return handoff;
          }),
        ).toBe(true);

        controller.abort();
        if (cleanupExpired) {
          await expect(
            operation.watchdog.tick(Date.now() + SESSION_WATCHDOG_CLEANUP_MS),
          ).resolves.toMatchObject({ action: "blocked" });
          expect(getSessionControllerOperation(sessionKey)).toBe(operation);
        }
        operation.fail("run_failed", producerError);
        operation.fail("run_failed", new Error("Later cleanup failure"));
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
        if (cleanupExpired) {
          // Raw delivery settlement cannot settle the separately owned handoff fence.
          delivery.resolve();
          await operation.ownerSettlement;
          expect(() => createTestReplyOperation({ sessionKey })).toThrow(
            ReplyRunSuccessorAdmissionBlockedError,
          );
        }
        persistence.resolve();
        await handoff;
        await expect(nextAdmission).resolves.toMatchObject({ settled: true });

        // Delivery may await this successor, but retains its own settlement receipt.
        if (!cleanupExpired) {
          expect(ownerSettled).not.toHaveBeenCalled();
        }
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
      const operation = createReplyOperation({
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
      const target = captureCurrentReplyMessageInjectionTarget(operation.key);
      if (!target) {
        throw new Error("Expected a live message injection target");
      }
      await expect(
        queueReplyMessageInjectionTarget(target, "different input", {
          terminalReplyExpectation:
            terminalReplyExpectation === "required" ? "optional" : "required",
        }),
      ).resolves.toEqual({ status: "rejected", reason: "reply_expectation_mismatch" });
      expect(queueMessage).not.toHaveBeenCalled();
      await expect(
        queueReplyMessageInjectionTarget(target, "matching input", {
          terminalReplyExpectation,
        }),
      ).resolves.toEqual({ status: "accepted" });
      expect(queueMessage).toHaveBeenCalledOnce();
    },
  );

  it.each(["key", "sessionId"] as const)(
    "fences retained controls after its %s changes",
    (field) => {
      const controller = new AbortController();
      const operation = createReplyOperation({
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
    const operation = createReplyOperation({
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
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    operation.complete();
    const successor = createReplyOperation({
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
