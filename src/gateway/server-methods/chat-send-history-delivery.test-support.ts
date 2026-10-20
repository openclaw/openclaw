import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  createQueueTestRun,
  createQueueSettings,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { completeFollowupRunLifecycle } from "../../auto-reply/reply/queue/lifecycle.js";
import { readReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import {
  appendTranscriptMessageSync,
  publishTranscriptUpdate,
} from "../../config/sessions/session-accessor.js";
import { bindSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import { isRpcSourceQueued } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import type { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

export function registerChatHistoryDeliveryCases(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  it.each(["webchat", "queued-webchat", "external"] as const)(
    "keeps committed history delivery with the %s source owner",
    async (route) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      const { params, scope } = fixture;
      const key = scope.sessionKey;
      const entered = createDeferred<Parameters<typeof dispatchInboundMessage>[0]>();
      const release = createDeferred();
      let settleQueued: (() => Promise<void>) | undefined;
      if (route === "external") {
        params.originatingChannel = "discord";
        params.originatingTo = "channel:synthetic";
        params.deliver = true;
      }
      dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
        const options = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
        if (route === "queued-webchat") {
          // The queue retains cancellation/admission after the initial dispatch unwinds.
          const input = readReplySourceInput(options.replyOptions);
          assert(input, "Expected original controller input");
          const run = createQueueTestRun({ prompt: params.message });
          run.turnAdoptionLifecycle = options.replyOptions?.turnAdoptionLifecycle;
          bindSessionControllerSource(input, run);
          const settings = createQueueSettings();
          const queued = enqueueFollowupRun(key, run, settings, "none", undefined, false);
          expect(queued).toBe(true);
          settleQueued = async () => {
            completeFollowupRunLifecycle(run);
            await input.settlement.promise;
          };
        }
        entered.resolve(options);
        if (route !== "queued-webchat") {
          await release.promise;
        }
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      try {
        const ack = await fixture.send();
        expect(ack.mock.calls[0]?.[0]).toBe(true);
        const { replyOptions } = await entered.promise;
        if (route === "queued-webchat") {
          await vi.waitFor(() =>
            expect(isRpcSourceQueued(rpcSourceTesting.get(params.idempotencyKey))).toBe(true),
          );
        }
        await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
        await replyOptions?.onAgentRunStart?.(params.idempotencyKey);
        const message = attachSessionTranscriptRunId(
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The synthetic fixture is ready.",
                textSignature: '{"v":1,"id":"receipt-answer","phase":"final_answer"}',
              },
              { type: "toolCall", id: "inspect", name: "read", arguments: {} },
            ],
            stopReason: "toolUse",
          },
          params.idempotencyKey,
        );
        const appended = appendTranscriptMessageSync(scope, {
          eventId: "route-answer",
          message,
        });
        assert(appended?.ok, "Expected committed route fixture answer");
        await publishTranscriptUpdate(scope, { message, messageId: "route-answer" });
        expect((await replyOptions?.resolveReplyDelivery?.()) ?? "missing").toBe(
          route === "external" ? "missing" : "delivered",
        );
        if (route === "queued-webchat") {
          await settleQueued?.();
          expect(await replyOptions?.resolveReplyDelivery?.()).toBe("missing");
        }
      } finally {
        await settleQueued?.();
        release.resolve();
        await fixture.cleanup();
      }
    },
  );
}
