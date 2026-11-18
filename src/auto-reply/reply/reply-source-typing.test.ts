import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
} from "./queue/lifecycle.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createSourceReplyDispatcherWithTyping } from "./reply-source-typing.js";
import { createTypingController } from "./typing.js";

it.each([false, true])(
  "retains queued feedback until source settlement (adopted=%s)",
  async (adopted) => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const runState: ReplyOperationRunState = {
      admission: { status: "accepted", mode: "followup" },
    };
    const source = createSourceReplyDispatcherWithTyping({
      runState,
      options: {
        deliver: async () => {},
        typingCallbacks: createTypingCallbacks({
          start,
          stop,
          onStartError: (error) => {
            throw error;
          },
          keepaliveIntervalMs: 0,
          maxDurationMs: 0,
        }),
      },
    });
    const options = source.replyOptions;
    const typing = createTypingController({
      onReplyStart: options.onReplyStart,
      onCleanup: options.onTypingCleanup,
      keepalive: false,
    });
    options.onTypingController?.(typing);
    const queued = createQueueTestRun({ prompt: "queued feedback" });
    queued.run.sessionKey = `agent:main:queued-feedback-${adopted}`;
    try {
      expect(markFollowupRunEnqueued(queued)).toBe(true);
      runState.sourceSettlement = queued.controllerInput!.settlement.promise;
      if (adopted) {
        await admitFollowupRunLifecycle(queued);
      }
      await settleReplyDispatcher({ dispatcher: source.dispatcher });
      source.completeIngress();
      expect(stop).not.toHaveBeenCalled();
      await typing.startTypingLoop();
      expect(start).toHaveBeenCalledOnce();
      completeFollowupRunLifecycle(queued, adopted ? "consumed" : undefined);
      await queued.controllerInput!.settlement.promise;
      expect(stop).toHaveBeenCalledOnce();
      await typing.startTypingLoop();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      completeFollowupRunLifecycle(queued);
      typing.cleanup();
    }
  },
);

it("finalizes a queued acknowledgement before its source settles", async ({ signal }) => {
  const sourceSettled = createDeferred();
  const finalization = createDeferred();
  const source = createSourceReplyDispatcherWithTyping({
    runState: {
      admission: { status: "accepted", mode: "followup" },
      sourceSettlement: sourceSettled.promise,
    },
    options: {
      deliver: async () => ({ finalization: finalization.promise }),
      onIdle: () => finalization.resolve(),
    },
  });
  source.dispatcher.sendFinalReply({ text: "Followup queued." });
  const drained = settleReplyDispatcher({ dispatcher: source.dispatcher });
  try {
    await withinTest(drained, signal);
    source.completeIngress();
  } finally {
    sourceSettled.resolve();
    finalization.resolve();
    await drained;
  }
});

it("keeps delivery open when typing completes before the resolver returns its final", async () => {
  const order: string[] = [];
  const source = createSourceReplyDispatcherWithTyping({
    runState: {},
    options: {
      deliver: async (payload) => {
        order.push(payload.text ?? "");
      },
      onReplyStart: async () => {},
      onIdle: () => {
        order.push("idle");
      },
    },
  });
  const typing = createTypingController({
    onReplyStart: source.replyOptions.onReplyStart,
    onCleanup: source.replyOptions.onTypingCleanup,
    keepalive: false,
  });
  source.replyOptions.onTypingController?.(typing);
  await typing.startTypingLoop();
  typing.markRunComplete();
  typing.markDispatchIdle();
  expect(order).toEqual([]);
  source.dispatcher.sendFinalReply({ text: "Replacement final." });
  await settleReplyDispatcher({ dispatcher: source.dispatcher });
  source.completeIngress();
  expect(order[0]).toBe("Replacement final.");
});
