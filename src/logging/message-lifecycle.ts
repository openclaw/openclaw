import {
  isSessionRunActive,
  isSessionRunActiveForKey,
} from "../sessions/session-controller.queries.js";
import { logMessageProcessed, logMessageQueued, logSessionStateChange } from "./diagnostic.js";

type MessageLifecycleRef = {
  sessionId?: string;
  sessionKey?: string;
};

export function createDiagnosticMessageLifecycle(
  params: MessageLifecycleRef & {
    enabled: boolean;
    channel: string;
    source: string;
    chatId?: number | string;
    messageId?: number | string;
    processingReason?: string;
    startedAtMs?: number;
    trackSessionState: boolean;
    agentId?: string;
    userPrompt?: string;
  },
) {
  const startedAtMs = params.startedAtMs ?? Date.now();
  const resolveRef = (override?: MessageLifecycleRef): MessageLifecycleRef => ({
    sessionId: override?.sessionId ?? params.sessionId,
    sessionKey: override?.sessionKey ?? params.sessionKey,
  });
  // Processed events still matter without a session ref; queue-depth/state events do not.
  const canTrackSessionState = (ref: MessageLifecycleRef): boolean =>
    params.enabled && params.trackSessionState && Boolean(ref.sessionId || ref.sessionKey);
  const isRunActive = (ref: MessageLifecycleRef): boolean =>
    ref.sessionKey
      ? isSessionRunActiveForKey(ref.sessionKey)
      : Boolean(ref.sessionId && isSessionRunActive(ref.sessionId));

  return {
    markProcessing(): void {
      const ref = resolveRef();
      if (!canTrackSessionState(ref)) {
        return;
      }
      logMessageQueued({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        channel: params.channel,
        source: params.source,
      });
      logSessionStateChange({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        // Receiving input precedes admission; retained cleanup may still hold its turn.
        state: isRunActive(ref) ? "processing" : "waiting",
        reason: params.processingReason,
      });
    },

    markIdle(reason?: string, override?: MessageLifecycleRef): void {
      const ref = resolveRef(override);
      if (!canTrackSessionState(ref)) {
        return;
      }
      // This message's dispatch is done, but another operation (for example a
      // scheduled run this input queued behind) may still own the session.
      // Controller retirement projects idle when that owner ends.
      logSessionStateChange({
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        state: isRunActive(ref) ? "processing" : "idle",
        reason,
        consumeQueuedTurn: true,
      });
    },

    markProcessed(
      outcome: "completed" | "skipped" | "error",
      options?: MessageLifecycleRef & {
        durationMs?: number;
        reason?: string;
        error?: string;
        userPrompt?: string;
        finalResponse?: string;
      },
    ): void {
      if (!params.enabled) {
        return;
      }
      const ref = resolveRef(options);
      logMessageProcessed({
        channel: params.channel,
        chatId: params.chatId,
        messageId: params.messageId,
        sessionId: ref.sessionId,
        sessionKey: ref.sessionKey,
        agentId: params.agentId,
        durationMs: options?.durationMs ?? Date.now() - startedAtMs,
        outcome,
        reason: options?.reason,
        error: options?.error,
        userPrompt: options?.userPrompt ?? params.userPrompt,
        finalResponse: options?.finalResponse,
      });
    },
  };
}
