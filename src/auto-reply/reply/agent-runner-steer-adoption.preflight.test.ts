import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { clearSessionQueues, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import type { ReplyBackendHandle } from "./reply-run-registry.contracts.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const key = "agent:main:preflight-steering";
afterEach(() => {
  clearSessionQueues([key]);
  resetRecentQueuedMessageIdDedupe();
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetCommandQueueStateForTest();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function steer(
  operation: ReplyOperation,
  fingerprint: string,
  run: FollowupRun,
  sessionEntry?: SessionEntry,
) {
  const typing = createMockTypingController();
  return runActiveReplySteer({
    followupRun: run,
    opts: undefined,
    providedReplyOperation: operation,
    queueKey: key,
    releaseAdmissionTicket: () => {},
    replyOperationRunState: {},
    resolvedQueue: { mode: "steer", debounceMs: 0 },
    restartRecoverySourceTurnId: run.messageId,
    runFollowup: async (queued) => {
      const admission = await admitReplyTurn({
        sessionKey: key,
        sessionId: operation.sessionId,
        kind: "queued_followup",
        resetTriggered: false,
        upstreamAbortSignal: queued.queueAbortSignal,
      });
      if (admission.status === "owned") {
        admission.operation.complete();
      }
    },
    sessionCtx: {},
    sessionKey: key,
    sessionEntry,
    touchActiveSessionEntry: async () => {},
    typing,
    typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
    toolAuthorityFingerprint: fingerprint,
  });
}

type QueueMessage = NonNullable<ReplyBackendHandle["messageInjection"]>["queueMessage"];

function backend(fingerprint: string, queueMessage: QueueMessage): ReplyBackendHandle {
  return {
    kind: "embedded",
    runId: "accepted-backing-work",
    toolAuthorityFingerprint: fingerprint,
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage },
  };
}

describe("steering received during foreground preflight compaction", () => {
  it.each(["phase-first", "backend-first"] as const)(
    "injects parked inputs FIFO without ending the run (%s)",
    async (order) => {
      vi.useFakeTimers();
      const first = createQueueTestRun({ prompt: "first input", messageId: "first" });
      await withQuestionCreator(key, first, async (operation, fingerprint) => {
        operation.setPhase("preflight_compacting");
        const entry: SessionEntry = { sessionId: operation.sessionId, updatedAt: 1 };
        const pending = [
          steer(operation, fingerprint, first, entry),
          steer(
            operation,
            fingerprint,
            { ...first, prompt: "second input", messageId: "second" },
            entry,
          ),
        ];
        const queueMessage = vi.fn<QueueMessage>(async () => {});
        try {
          await vi.advanceTimersByTimeAsync(0);
          expect(queueMessage).not.toHaveBeenCalled();
          entry.sessionId = "compacted-session";
          operation.updateSessionId(entry.sessionId);
          if (order === "phase-first") {
            operation.setPhase("running");
            operation.attachBackend(backend(fingerprint, queueMessage));
          } else {
            operation.attachBackend(backend(fingerprint, queueMessage));
            operation.setPhase("running");
          }
          pending.push(
            steer(
              operation,
              fingerprint,
              { ...first, prompt: "new input", messageId: "new" },
              entry,
            ),
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(queueMessage.mock.calls.map(([text]) => text)).toEqual([
            "first input",
            "second input",
            "new input",
          ]);
          expect(operation.result).toBeNull();
          expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
          await Promise.all(pending);
        } finally {
          operation.complete();
          await Promise.allSettled(pending);
        }
      });
    },
  );
  it.each(["cancelled", "failed", "replaced"] as const)(
    "settles waiting input without injecting into another owner when %s",
    async (outcome) => {
      vi.useFakeTimers();
      const first = createQueueTestRun({ prompt: "waiting input", messageId: "waiting" });
      const controller = new AbortController();
      first.abortSignal = controller.signal;
      await withQuestionCreator(key, first, async (operation, fingerprint) => {
        operation.setPhase("preflight_compacting");
        let settled = false;
        const pending = steer(operation, fingerprint, first).then(() => {
          settled = true;
        });
        const queueMessage = vi.fn<QueueMessage>(async () => {});
        let replacement: ReplyOperation | undefined;
        try {
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toBe(false);
          expect(first.steerPending?.phase).toBe("waiting");
          if (outcome === "cancelled") {
            controller.abort();
          } else if (outcome === "failed") {
            operation.retainFailureUntilComplete();
            operation.fail("run_failed", new Error("synthetic preflight failure"));
          } else {
            operation.complete();
            replacement = createReplyOperation({
              sessionKey: key,
              sessionId: "replacement-session",
              resetTriggered: false,
            });
            replacement.attachBackend(backend(fingerprint, queueMessage));
            replacement.setPhase("running");
          }
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toBe(true);
          operation.attachBackend(backend(fingerprint, queueMessage));
          operation.setPhase("running");
          await pending;
          expect(queueMessage).not.toHaveBeenCalled();
          expect(first.steerPending).toBeUndefined();
        } finally {
          controller.abort();
          replacement?.complete();
          operation.complete();
          await pending;
        }
      });
    },
  );

  it.each(["authority-mismatch", "backend-rejection"] as const)(
    "keeps the normal fallback after readiness for %s",
    async (outcome) => {
      vi.useFakeTimers();
      const first = createQueueTestRun({ prompt: "waiting input", messageId: "waiting" });
      await withQuestionCreator(key, first, async (operation, fingerprint) => {
        operation.setPhase("preflight_compacting");
        const queueMessage = vi.fn<QueueMessage>(async () => {
          throw new Error("backend rejected input");
        });
        const pending = steer(
          operation,
          outcome === "authority-mismatch" ? "wrong-authority" : fingerprint,
          first,
        );
        try {
          await vi.advanceTimersByTimeAsync(0);
          operation.attachBackend(backend(fingerprint, queueMessage));
          operation.setPhase("running");
          await vi.advanceTimersByTimeAsync(0);
          await pending;
          expect(queueMessage).toHaveBeenCalledTimes(outcome === "authority-mismatch" ? 0 : 1);
          expect(first.steerPending).toBeUndefined();
          expect(getExistingFollowupQueue(key)?.items).toContain(first);
        } finally {
          operation.complete();
          await pending;
        }
      });
    },
  );
});
