import type { SessionsSteerActiveResult } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionAttempt,
} from "../../sessions/session-controller.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type {
  createChatSendMessageInjectionStarter,
  finalizeAcceptedChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/** Completes only the existing input owner. No reply-dispatch or retry path is reachable. */
export async function finishActiveSteerInput(
  setup: { admission: AdmittedChatSend; session: PreparedChatSendSession },
  params: {
    context: GatewayRequestContext;
    ctx: RuntimeMsgContext;
    userTurnRecorder: UserTurnTranscriptRecorder;
    begin: ReturnType<typeof createChatSendMessageInjectionStarter>;
    persist: Parameters<
      typeof finalizeAcceptedChatSendMessageInjection
    >[0]["persistUserTurnTranscriptBestEffort"];
    assertCurrent: () => void;
    respond: RespondFn;
  },
) {
  const { admission, session } = setup;
  const { userTurnRecorder: recorder } = params;
  const result: Omit<SessionsSteerActiveResult, "status"> & {
    status: Exclude<SessionsSteerActiveResult["status"], "in_flight">;
  } = {
    inputId: session.clientRunId,
    runId: admission.messageInjectionTarget!.runId!,
    status: "rejected",
    receiptPersisted: false,
  };
  try {
    await admission.gatewayWorkAdmission.run(async () => {
      let attempt: ReplyMessageInjectionAttempt | undefined;
      try {
        params.assertCurrent();
        attempt = await withCurrentUserTurnInput(recorder, params.begin);
      } catch {
        // Preparation rejects before handing off a native attempt. Nothing was delivered.
        result.reason = "active-steer-preparation-failed";
      }
      if (attempt) {
        try {
          const nativeOutcome = await attempt.outcome;
          if (nativeOutcome.status === "failed") {
            // The injection owner proved refusal before acceptance (or withdrawal).
            result.reason = "active-steer-source-rejected";
          } else {
            const outcome = await finalizeReplyMessageInjectionAttempt({
              attempt,
              target: admission.messageInjectionTarget!,
              onOutcome: (status) => {
                result.status = status;
              },
            });
            result.status = outcome.status;
            if (outcome.status === "rejected") {
              result.reason = outcome.outcome.reason;
            }
            if (outcome.status === "indeterminate") {
              result.reason = outcome.outcome.errorMessage;
            }
          }
        } catch {
          // An exceptional handed-off outcome cannot prove safe replay. Keep known acceptance.
          if (result.status !== "accepted") {
            result.status = "indeterminate";
          }
          result.reason = "active-steer-receipt-unavailable";
        }
      } else {
        result.reason ??= "active-steer-unavailable";
      }
      if (result.status === "accepted" || result.status === "indeterminate") {
        recordAcceptedSessionParticipantInput(params.ctx, {
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          storePath: session.storePath,
        });
        await params.persist();
        const receipt = recorder.getAdmissionReceipt();
        if (receipt) {
          result.messageSeq = receipt.activeMessagePosition + 1;
        }
      }
      try {
        const completion = await recorder.completeProcessingAsync?.({
          status: result.status === "accepted" ? "ok" : "error",
          reason: result.status === "accepted" ? "completed" : "failed",
          activeSteer: {
            runId: result.runId,
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
          },
          endedAt: Date.now(),
        });
        result.receiptPersisted = completion?.activeSteer !== undefined;
      } catch {
        params.context.logGateway.warn(
          "Active steering input receipt could not be persisted; retry only the original request.",
        );
      }
      if (recorder.isPendingInputConsumed?.()) {
        recorder.releasePendingInput?.();
      } else {
        // Native outcome and transcript placement are independent. Retire custody,
        // preserving the fingerprinted source and completion for exact retries.
        recorder.finishPendingInput?.("cancelled", "failed");
      }
      try {
        await recorder.waitForPendingInputSettlement?.();
      } catch {
        result.receiptPersisted = false;
        params.context.logGateway.warn(
          "Active steering input settlement failed; retry only the original request.",
        );
      }
    });
    params.respond(true, result);
  } finally {
    clearAgentRunContext(session.clientRunId, admission.lifecycleGeneration);
    admission.cleanupAdmittedRun();
  }
}
