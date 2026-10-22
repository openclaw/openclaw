import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { bindReplySourceInput } from "./reply-source-binding.js";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

export function registerHeartbeatPreemptionCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (overrides?: Partial<ReplyRunParams>) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it.for([
    { admission: "keyed", kind: "visible" },
    { admission: "reserved source", kind: "visible" },
    { admission: "keyed", kind: "exec completion" },
    { admission: "reserved source", kind: "exec completion" },
  ] as const)(
    "preempts a native heartbeat only for visible turns ($admission, $kind)",
    async ({ admission, kind }, { signal }) => {
      const completion = kind === "exec completion";
      const mode = completion ? "followup" : "steer";
      vi.mocked(resolveQueueSettings).mockReturnValueOnce({ mode });
      vi.useFakeTimers();
      const sessionId = "session-embedded-heartbeat";
      const target = captureSessionTarget({
        storeScope: resolveSessionStorePathCore(undefined, { agentId: "default" }),
        sessionKey: "session-key",
        incarnation: sessionId,
        agentId: "default",
      });
      const heartbeat = createReplyOperation({
        sessionId,
        sessionKey: target.sessionKey,
        target,
        turnKind: "heartbeat",
        resetTriggered: false,
      });
      const preempted = createDeferred();
      const cleanup = createDeferred();
      const native = {
        queueMessage: vi.fn(async () => {}),
        isStreaming: () => true,
        isCompacting: () => false,
        preemptByVisibleTurn: vi.fn(() => {
          preempted.resolve();
          return true;
        }),
        abort: vi.fn(),
      };
      const attachment = attachActiveEmbeddedRun(
        sessionId,
        native,
        target.sessionKey,
        undefined,
        target.agentId,
        heartbeat,
      );
      if (!attachment) {
        throw new Error("Expected an admitted heartbeat attachment");
      }
      attachment.runCleanupSettlement = cleanup.promise;
      // Ingress cannot own a second operation beside the heartbeat.
      const source =
        admission === "reserved source"
          ? reserveSessionControllerSource(target.sessionKey, { target, policy: { mode } })
          : undefined;
      const opts: ReplyRunParams["opts"] = completion
        ? { internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() } }
        : {};
      const body = completion ? "Exec completed (health-check, code 0) :: OK" : "answer this now";
      const route = { OriginatingChannel: "telegram", OriginatingTo: "user:1" };
      const running = runPrepared({
        isNewSession: false,
        sessionId,
        opts: source ? bindReplySourceInput(opts, source) : opts,
        ctx: { ...createInboundTurn(body, "telegram", "direct"), ...route },
        sessionCtx: { ...createSessionTurn(body, "telegram", "direct"), ...route },
      });
      try {
        if (completion) {
          await withinTest(
            awaitGateBeforeSettlement(
              running,
              preempted.promise,
              "Exec completion superseded its originating heartbeat",
            ),
            signal,
          );
          expect(native.preemptByVisibleTurn).not.toHaveBeenCalled();
          expect(heartbeat.abortSignal.aborted).toBe(false);
          expect(heartbeat.result).toBeNull();
          expect(requireRunReplyAgentCall()).toMatchObject({
            shouldSteer: false,
            shouldFollowup: true,
            isActive: true,
          });
          return;
        }
        await withinTest(
          awaitGateBeforeSettlement(
            preempted.promise,
            running,
            "Visible turn bypassed the heartbeat",
          ),
          signal,
        );
        expect(runReplyAgent).not.toHaveBeenCalled();
        detachActiveEmbeddedRun(sessionId, native, target.sessionKey);
        heartbeat.complete();
        await withinTest(heartbeat.ownerSettlement, signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(runReplyAgent).not.toHaveBeenCalled();

        cleanup.resolve();
        await expect(withinTest(running, signal)).resolves.toEqual({ text: "ok" });
        expect(native.preemptByVisibleTurn).toHaveBeenCalledOnce();
        expect(native.abort).not.toHaveBeenCalled();
        expect(runReplyAgent).toHaveBeenCalledOnce();
        expect(requireRunReplyAgentCall()).toMatchObject({
          shouldSteer: false,
          shouldFollowup: false,
          isActive: false,
        });
      } finally {
        cleanup.resolve();
        detachActiveEmbeddedRun(sessionId, native, target.sessionKey);
        heartbeat.complete();
        if (source) {
          retireSessionControllerInput(source);
        }
        await running.catch(() => {});
        vi.useRealTimers();
      }
    },
  );
}
