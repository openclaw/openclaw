import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { notifyPreparedAgentRunStart } from "../agent-run-start.js";
import { createCommandTurnContext } from "../command-turn-context.js";
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

export function registerQueuedFollowupNoticeCases(): void {
  it.each(["direct", "routed"] as const)(
    "delivers one explicit followup start notice before the pending %s reply",
    async (route) => {
      setNoAbort();
      const streamed = createDeferred();
      const releaseReply = createDeferred();
      const deliveredTexts: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          deliveredTexts.push(payload.text ?? "");
        },
      });
      mocks.routeReply.mockImplementation(async ({ payload }) => {
        deliveredTexts.push(payload.text ?? "");
        return { ok: true, delivered: true, messageId: "followup-start" };
      });
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          SessionKey: `test:followup-start:${route}`,
          Body: "summarize the report",
          CommandTurn: createCommandTurnContext("text", {
            authorized: true,
            commandName: "followup",
            body: "/followup summarize the report",
          }),
          ...(route === "routed"
            ? { OriginatingChannel: "telegram", OriginatingTo: "chat:followup-start" }
            : {}),
        }),
        cfg: {},
        dispatcher,
        replyOptions: { onPreparedAgentRunStart: () => "reply-dispatch" },
        replyResolver: async (_ctx, opts) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            expect(
              notifyPreparedAgentRunStart(opts, {
                runId: "followup-run",
                transcriptStart: null,
              }),
            ).toBe("reply-dispatch");
          }
          await opts?.onBlockReply?.({ text: "The report covers three items." });
          await dispatcher.waitForIdle();
          streamed.resolve();
          await releaseReply.promise;
          return { text: "Summary complete." };
        },
      });
      try {
        await awaitGateBeforeSettlement(
          streamed.promise,
          dispatch,
          "reply settled before streaming",
        );
        expect(deliveredTexts).toEqual([
          "Your followup has started.",
          "The report covers three items.",
        ]);
      } finally {
        releaseReply.resolve();
        await dispatch;
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      expect(deliveredTexts).toEqual([
        "Your followup has started.",
        "The report covers three items.",
        "Summary complete.",
      ]);
    },
  );

  it.each([
    {
      reason: "collaborative-steering-disabled",
      notice:
        "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.",
      fallbackDelivered: undefined,
    },
    { reason: "queue-cap", notice: QUEUE_CAP_REJECTION_TEXT, fallbackDelivered: true },
  ] as const)(
    "reports $reason without claiming queueing or cancellation",
    async ({ reason, notice, fallbackDelivered }) => {
      setNoAbort();
      diagnosticMocks.logMessageDispatchCompleted.mockClear();
      const sessionKey = `test:${reason}`;
      const deliveredTexts: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          deliveredTexts.push(payload.text ?? "");
        },
      });
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({ ChatType: "direct", SessionKey: sessionKey, Body: "stop" }),
        cfg: { diagnostics: { enabled: true } },
        dispatcher,
        replyResolver: async (_ctx, opts) => {
          const state = resolveReplyOperationRunState(opts);
          if (!state) {
            throw new Error("expected reply operation state");
          }
          state.admission = { status: "skipped", reason };
          return undefined;
        },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(deliveredTexts).toEqual([notice]);
      expect(result.noVisibleReplyFallbackDelivered).toBe(fallbackDelivered);
      expect(result.deferredToActiveRun).toBeUndefined();
      if (reason === "collaborative-steering-disabled") {
        expect(result.collaborativeSteeringRefused).toBe(true);
      }
      expect(diagnosticMocks.logMessageDispatchCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "skipped", reason, sessionKey }),
      );
    },
  );

  it.each([
    { phase: "still queued", reason: "explicit-followup" },
    { phase: "still queued", reason: "steering-unavailable" },
    { phase: "evicted before finalization", reason: "explicit-followup" },
    { phase: "evicted during progress flush", reason: "steering-unavailable" },
  ] as const)("reports a truthful $reason queue notice when $phase", async ({ phase, reason }) => {
    setNoAbort();
    const sessionKey = `test:queue-notice:${reason}:${phase}`;
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
