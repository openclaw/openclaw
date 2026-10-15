import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { QUEUE_CAP_REJECTION_TEXT } from "./dispatch-from-config.payloads.js";
import { diagnosticMocks, mocks } from "./dispatch-from-config.shared.test-harness.js";
import { dispatchReplyFromConfig, setNoAbort } from "./dispatch-from-config.test-support.js";
import {
  clearFollowupQueueForTest,
  createQueueSettings,
  createQueueTestRun,
} from "./queue.test-helpers.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import { bindReplyOperationQueueDisposition } from "./queue/types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerQueuedFollowupNoticeCases(noVisibleReplyFallbackText: string): void {
  it("reports queue-cap rejection instead of a temporary model failure", async () => {
    setNoAbort();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    const deliveredTexts: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async (payload) => {
        deliveredTexts.push(payload.text ?? "");
      }),
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation state");
      }
      runState.admission = { status: "skipped", reason: "queue-cap" };
      return undefined;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "test:queue-cap" }),
      cfg: { diagnostics: { enabled: true } },
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredTexts).toEqual([QUEUE_CAP_REJECTION_TEXT]);
    expect(deliveredTexts).not.toContain(noVisibleReplyFallbackText);
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "queue-cap",
        sessionKey: "test:queue-cap",
      }),
    );
  });

  it.each([
    { phase: "still queued", reason: "requester-mismatch" },
    { phase: "still queued", reason: "steering-unavailable" },
    { phase: "evicted before finalization", reason: "requester-mismatch" },
    { phase: "evicted during progress flush", reason: "steering-unavailable" },
  ] as const)("reports a truthful $reason queue notice when $phase", async ({ phase, reason }) => {
    setNoAbort();
    const sessionKey = `test:queue-notice:${phase}`;
    const queued = createDeferred();
    const releaseReply = createDeferred();
    const progressStarted = createDeferred();
    const releaseProgress = createDeferred();
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "old" });
    const run = createQueueTestRun({ prompt: "stop the current work", messageId: "bob" });
    const disposition = vi.fn();
    run.onQueueDisposition = disposition;
    const deliveredTexts: string[] = [];
    const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
    mocks.routeReply.mockImplementation(async ({ payload }) => {
      if (payload.text === "💬 Preparing the queue notice") {
        progressStarted.resolve();
        await releaseProgress.promise;
      }
      deliveredTexts.push(payload.text ?? "");
      return { ok: true, delivered: true, messageId: "queue-notice" };
    });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation state");
      }
      bindReplyOperationQueueDisposition(run, runState);
      expect(enqueueFollowupRun(sessionKey, run, settings, "message-id", undefined, false)).toBe(
        true,
      );
      runState.admission = { status: "accepted", mode: "followup", reason };
      if (phase === "evicted during progress flush") {
        await opts?.onItemEvent?.({
          itemId: "queue-progress",
          kind: "preamble",
          progressText: "Preparing the queue notice",
        });
      }
      queued.resolve();
      await releaseReply.promise;
      return undefined;
    };
    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        SessionKey: sessionKey,
        SenderId: "bob",
        OriginatingChannel: "telegram",
        OriginatingTo: "chat:queue-notice",
      }),
      cfg: { agents: { defaults: { verboseDefault: "on" } } },
      dispatcher,
      replyResolver,
    });
    const evict = () => {
      expect(
        enqueueFollowupRun(
          sessionKey,
          createQueueTestRun({ prompt: "Later input", messageId: "charlie" }),
          settings,
          "message-id",
          undefined,
          false,
        ),
      ).toBe(true);
    };
    try {
      await awaitGateBeforeSettlement(
        queued.promise,
        dispatch,
        "dispatch settled before accepting the queued followup",
      );
      expect(getFollowupQueueDepth(sessionKey)).toBe(1);
      expect(deliveredTexts).toEqual([]);
      if (phase === "evicted before finalization") {
        evict();
      }
      releaseReply.resolve();
      if (phase === "evicted during progress flush") {
        await awaitGateBeforeSettlement(
          progressStarted.promise,
          dispatch,
          "dispatch settled before flushing the queued commentary",
        );
        expect(deliveredTexts).toEqual([]);
        evict();
        releaseProgress.resolve();
      }
      const result = await dispatch;
      expect(deliveredTexts).toEqual([
        ...(phase === "evicted during progress flush" ? ["💬 Preparing the queue notice"] : []),
        phase === "still queued"
          ? "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress."
          : "Your queued message was dropped because the session queue is full. It hasn’t changed the work already in progress. Please send it again after the current response finishes.",
      ]);
      if (phase === "still queued") {
        expect(disposition).not.toHaveBeenCalled();
      } else {
        expect(disposition).toHaveBeenCalledExactlyOnceWith("queue-cap-old");
      }
      // Later eviction must not erase the initial acceptance or emit the never-queued fallback.
      expect(result.deferredToActiveRun).toBe("followup");
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    } finally {
      releaseReply.resolve();
      releaseProgress.resolve();
      await dispatch.catch(() => undefined);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      clearFollowupQueueForTest(sessionKey);
    }
  });
}
