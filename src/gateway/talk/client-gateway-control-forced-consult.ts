import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../../talk/agent-run-control-shared.js";
import { readSpeakableRealtimeVoiceToolResult } from "../../talk/consult-question.js";
import {
  buildAlreadyDeliveredToolResult,
  buildRealtimeVoiceForcedConsultArgs,
  REALTIME_VOICE_FORCED_CONSULT_FALLBACK_DELAY_MS,
  type RealtimeVoiceForcedConsultCoordinator,
} from "../../talk/forced-consult-coordinator.js";

const FORCED_CONSULT_FAILURE_SPEECH = "OpenClaw could not finish that request. Please try again.";
// Admission stays sealed after overflow, so only a new call can take more work.
const FORCED_CONSULT_QUEUE_FULL_SPEECH =
  "OpenClaw cannot take more requests on this call. Please start a new call to ask again.";

export type TalkConsultOutcome = "completed" | "cancelled" | "failed";

/**
 * Forced consult routing for a Gateway-controlled call. The call owner runs each
 * consult; this keeps one consult per final transcript, deduped against native calls.
 */
export function createTalkGatewayForcedConsultRouter(params: {
  forcedConsults: RealtimeVoiceForcedConsultCoordinator;
  /** Admits one Gateway-run consult; false when the call's consult queue is full. */
  startConsult: (
    consultId: string,
    args: unknown,
    deliver: (result: unknown, outcome: TalkConsultOutcome) => void,
  ) => boolean;
  speak: (text: string) => void;
  isClosed: () => boolean;
  warn: (message: string) => void;
}) {
  const { forcedConsults, warn } = params;
  const speak = (text: string) => {
    try {
      params.speak(text);
    } catch (error) {
      warn(`talk Gateway control forced consult speech failed: ${formatError(error)}`);
    }
  };
  return {
    scheduleForFinalTranscript(question: string): void {
      if (forcedConsults.hasRecentNativeConsult(question)) {
        warn("talk Gateway control skipped forced consult: provider already consulted the agent");
        return;
      }
      forcedConsults.clearPending();
      const handle = forcedConsults.prepare(question);
      if (!handle) {
        return;
      }
      forcedConsults.schedule(handle, REALTIME_VOICE_FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
        if (params.isClosed()) {
          return;
        }
        forcedConsults.markStarted(handle);
        try {
          const started = params.startConsult(
            handle.id,
            buildRealtimeVoiceForcedConsultArgs(handle.question),
            (result, outcome) => {
              if (outcome === "cancelled") {
                // Spoken cancel controls already answer the caller.
                forcedConsults.markCancelled(handle);
                return;
              }
              forcedConsults.markDelivered(handle);
              let text = readSpeakableRealtimeVoiceToolResult(result);
              if (outcome === "failed") {
                warn(`talk Gateway control forced consult failed: ${text ?? "unknown error"}`);
                text = FORCED_CONSULT_FAILURE_SPEECH;
              }
              if (!text) {
                warn("talk Gateway control forced consult returned no speakable result");
                return;
              }
              speak(text);
            },
          );
          if (!started) {
            forcedConsults.markCancelled(handle);
            warn("talk Gateway control dropped forced consult: consult queue is full");
            speak(FORCED_CONSULT_QUEUE_FULL_SPEECH);
          }
        } catch (error) {
          forcedConsults.markCancelled(handle);
          warn(`talk Gateway control forced consult not started: ${formatError(error)}`);
        }
      });
    },
    /**
     * Returns the provider result for a native consult that a started forced consult
     * already owns; undefined lets the native call run.
     */
    claimNativeConsult(args: unknown, callId: string): unknown {
      // A pending forced consult yields to this native call; a started one owns the request.
      const forced = forcedConsults.recordNativeConsult(args, callId);
      if (forced.kind !== "in_flight" && forced.kind !== "already_delivered") {
        return undefined;
      }
      warn(`talk Gateway control skipped native consult: forced consult ${forced.kind}`);
      return forcedConsults.isCancelled(forced.handle)
        ? buildRealtimeVoiceAgentCancelProviderResult(
            "OpenClaw cancelled this consult before completion. Do not restart it.",
          )
        : buildAlreadyDeliveredToolResult();
    },
  };
}
