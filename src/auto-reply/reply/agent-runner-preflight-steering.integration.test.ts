// Core integration boundary: actual runReplyAgent policy, admission tickets,
// queue and steering path. The provider/backend transport remains synthetic.
import { afterEach, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { clearSessionQueues, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { REPLY_ADMISSION_TICKET, reserveReplyAdmissionTicket } from "./reply-admission-ticket.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import type { ReplyBackendHandle } from "./reply-run-registry.contracts.js";
import { testing } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const key = "agent:main:preflight-caller-integration";
type QueueMessage = NonNullable<ReplyBackendHandle["messageInjection"]>["queueMessage"];

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

it("releases inbound admission during preflight and steers both queued inputs before the active run ends", async () => {
  vi.useFakeTimers();
  const first = createQueueTestRun({ prompt: "first incoming message", messageId: "first" });
  await withQuestionCreator(key, first, async (operation, fingerprint) => {
    operation.setPhase("preflight_compacting");
    const second: FollowupRun = {
      ...first,
      prompt: "second incoming message",
      messageId: "second",
      run: { ...first.run },
    };
    const firstState: ReplyOperationRunState = {};
    const secondState: ReplyOperationRunState = {};
    const firstTicket = reserveReplyAdmissionTicket([key]);
    const secondTicket = reserveReplyAdmissionTicket([key]);
    if (!firstTicket || !secondTicket) {
      throw new Error("expected scoped admission tickets");
    }
    const launch = (run: FollowupRun, state: ReplyOperationRunState, ticket: typeof firstTicket) =>
      runReplyAgent({
        commandBody: run.prompt,
        transcriptCommandBody: run.prompt,
        followupRun: run,
        opts: {
          runId: run.messageId,
          [REPLY_OPERATION_RUN_STATE]: state,
          [REPLY_ADMISSION_TICKET]: ticket,
        },
        queueKey: key,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        shouldSteer: true,
        shouldFollowup: false,
        isActive: true,
        typing: createMockTypingController(),
        sessionCtx: {},
        sessionKey: key,
        defaultModel: "openai/gpt-test",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "text_end",
        shouldInjectGroupIntro: false,
        typingMode: "never",
      });
    const pending: ReturnType<typeof runReplyAgent>[] = [];
    const queueMessage = vi.fn<QueueMessage>(async () => {});
    try {
      await expect(firstTicket.wait()).resolves.toBe(true);
      pending.push(launch(first, firstState, firstTicket));
      void pending.at(-1)?.catch(() => {});
      let secondAdmitted = false;
      const secondReady = secondTicket.wait().then((ready) => {
        secondAdmitted = ready;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(secondAdmitted).toBe(true);
      await secondReady;
      pending.push(launch(second, secondState, secondTicket));
      void pending.at(-1)?.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(getExistingFollowupQueue(key)?.items.map((run) => run.prompt)).toEqual([
        first.prompt,
        second.prompt,
      ]);
      expect(first.steerPending?.phase).toBe("waiting");
      expect(second.steerPending?.phase).toBe("waiting");
      expect(queueMessage).not.toHaveBeenCalled();

      operation.attachBackend({
        kind: "embedded",
        runId: "accepted-backing-work",
        toolAuthorityFingerprint: fingerprint,
        cancel: vi.fn(),
        messageInjection: { isAvailable: () => true, queueMessage },
      });
      operation.setPhase("running");
      await vi.advanceTimersByTimeAsync(0);
      expect(queueMessage.mock.calls.map(([text]) => text)).toEqual([first.prompt, second.prompt]);
      await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined]);
      expect(firstState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(secondState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(operation.result).toBeNull();
      expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
    } finally {
      // Never let a failed assertion dispatch the fallback through a live model.
      clearSessionQueues([key]);
      firstTicket.release();
      secondTicket.release();
      operation.complete();
      await Promise.allSettled(pending);
    }
  });
});
