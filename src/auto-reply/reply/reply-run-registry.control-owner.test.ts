import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveActiveReplyRunOwnerForSignal } from "../../sessions/session-controller.barriers.js";
import type { ReplyBackendHandle } from "../../sessions/session-controller.contracts.js";
import {
  ReplyRunSuccessorAdmissionBlockedError,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { SESSION_WATCHDOG_CLEANUP_MS } from "../../sessions/session-controller.watchdog-state.js";
import {
  createTestReplyOperation,
  queueReplyMessageInjectionTarget,
} from "./reply-run-registry.test-helpers.js";

const sessionKey = "agent:main:voice-control";
function createOperation(
  sessionId = "session-1",
  upstreamAbortSignal?: AbortSignal,
  backend?: Omit<ReplyBackendHandle, "kind" | "cancel">,
) {
  const operation = createTestReplyOperation({ sessionKey, sessionId, upstreamAbortSignal });
  if (backend) {
    operation.attachBackend({ kind: "embedded", cancel: vi.fn(), ...backend });
    operation.setPhase("running");
  }
  return operation;
}
function controlled(sessionId: string, running = false) {
  const controller = new AbortController();
  const operation = createOperation(sessionId, controller.signal);
  if (running) {
    operation.setPhase("running");
  }
  const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
  return { controller, operation, owner };
}

afterEach(() => getSessionControllerOperation(sessionKey)?.complete());

it("retains failed admission for the SDK opt-in until completion", async () => {
  const operation = createOperation();
  const settled = vi.fn();
  void operation.ownerSettlement.then(settled);
  operation.setPhase("running");
  operation.retainFailureUntilComplete();
  operation.fail("run_failed", new Error("provider failed"));
  await Promise.resolve();

  expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
  expect(getSessionControllerOperation(sessionKey)).toBe(operation);
  expect(settled).not.toHaveBeenCalled();
  expect(() => createOperation()).toThrow();

  operation.complete();
  await operation.ownerSettlement;
  expect(settled).toHaveBeenCalledOnce();
  expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
  createOperation("successor").complete();
});

it.each([
  [
    "sourceReplyDeliveryMode",
    undefined,
    "message_tool_only",
    "source_reply_delivery_mode_mismatch",
  ],
  ["sourceReplyDeliveryMode", "message_tool_only", "message_tool_only", undefined],
  ["terminalReplyExpectation", "required", "optional", "reply_expectation_mismatch"],
  ["terminalReplyExpectation", "optional", "required", "reply_expectation_mismatch"],
] as const)("preserves %s=%s when injecting %s", async (field, incumbent, incoming, reason) => {
  const queueMessage = vi.fn(async () => {});
  const policy =
    field === "sourceReplyDeliveryMode"
      ? { sourceReplyDeliveryMode: incumbent }
      : { terminalReplyExpectation: incumbent };
  const input =
    field === "sourceReplyDeliveryMode"
      ? { sourceReplyDeliveryMode: incoming }
      : { terminalReplyExpectation: incoming };
  const operation = createOperation("policy-owner", undefined, { ...policy, queueMessage });
  const target = captureCurrentReplyMessageInjectionTarget(operation.key)!;
  await expect(queueReplyMessageInjectionTarget(target, "input", input)).resolves.toEqual(
    reason ? { status: "rejected", reason } : { status: "accepted" },
  );
  expect(queueMessage).toHaveBeenCalledTimes(reason ? 0 : 1);
  if (field === "terminalReplyExpectation") {
    await expect(
      queueReplyMessageInjectionTarget(target, "matching input", policy),
    ).resolves.toEqual({ status: "accepted" });
    expect(queueMessage).toHaveBeenCalledOnce();
  } else if (!reason) {
    expect(queueMessage).toHaveBeenCalledExactlyOnceWith("input", expect.objectContaining(input));
  }
});

it.each([false, true])(
  "settles producer handoff before delivery can admit a successor (cleanup expired=%s)",
  async (cleanupExpired) => {
    const { controller, operation, owner } = controlled("session-1", true);
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
      expect(() => createOperation()).toThrow();

      operation.completeWithAfterClearBarrier(delivery.promise);
      await Promise.resolve();
      expect(started).toHaveBeenCalledOnce();
      expect(() => createOperation()).toThrow(ReplyRunSuccessorAdmissionBlockedError);
      const nextAdmission = waitForReplyRunSuccessorAdmission(operation.key, null);
      if (cleanupExpired) {
        // Raw delivery settlement cannot settle the separately owned handoff fence.
        delivery.resolve();
        await operation.ownerSettlement;
        expect(() => createOperation()).toThrow(ReplyRunSuccessorAdmissionBlockedError);
      }
      persistence.resolve();
      await handoff;
      await expect(nextAdmission).resolves.toMatchObject({ settled: true });

      // Delivery may await this successor, but retains its own settlement receipt.
      if (!cleanupExpired) {
        expect(ownerSettled).not.toHaveBeenCalled();
      }
      createOperation("successor").complete();
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

it.each(["key", "sessionId", "replacement"] as const)(
  "fences retained controls after %s changes",
  (field) => {
    const { controller, operation, owner } = controlled("original-session");
    let current = operation;
    try {
      if (field === "key") {
        operation.updateSessionKey("agent:main:voice-control-rekeyed");
      } else if (field === "sessionId") {
        operation.updateSessionId("replacement-session");
      } else {
        operation.complete();
        current = createOperation("original-session", new AbortController().signal);
        expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
      }
      expect(owner?.abort()).toBe(false);
      expect(current.abortSignal.aborted).toBe(false);
    } finally {
      current.complete();
    }
  },
);

it("controls a queued reply only through its admitted upstream signal", () => {
  const { controller, operation, owner } = controlled("queued-session");
  expect(resolveActiveReplyRunOwnerForSignal(new AbortController().signal)).toBeUndefined();
  expect(owner?.sessionId).toBe("queued-session");
  expect(owner?.abort()).toBe(true);
  expect(operation.abortSignal.aborted).toBe(true);
  expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
});
