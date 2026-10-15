import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
/** Runtime ACP manager dependencies and stale-binding cleanup used by reply dispatch. */
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { notifyPreparedAgentRunStart } from "../agent-run-start.js";
import type { GetReplyOptions, ReplyDispatchRun } from "../get-reply-options.types.js";
export { getAcpSessionManager } from "../../acp/control-plane/manager.js";
export { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";
export { listSessionBindingsBySessionAsync } from "../../infra/outbound/session-binding-service.js";

const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";

/** Prepare transcript evidence before offering synchronous reply completion ownership. */
export async function prepareAcpDispatchStart(params: {
  scope: Omit<SessionTranscriptRuntimeTarget, "sessionId">;
  sessionId?: string;
  runId: string;
  onAgentRunStart?: GetReplyOptions["onAgentRunStart"];
  onPreparedAgentRunStart?: GetReplyOptions["onPreparedAgentRunStart"];
  getResult: ReplyDispatchRun["getResult"];
}) {
  const { agentId, sessionKey, storePath } = params.scope;
  const transcriptStart =
    (params.onPreparedAgentRunStart || params.onAgentRunStart) && params.sessionId
      ? await (
          await import("../../config/sessions/session-transcript-watermark.js")
        ).readSessionTranscriptStartAsync({
          agentId,
          sessionKey,
          storePath,
          sessionId: params.sessionId,
        })
      : null;
  return () => {
    const owner = notifyPreparedAgentRunStart(params, {
      runId: params.runId,
      options: { completionSource: "reply-dispatch", getResult: params.getResult },
      transcriptStart,
    });
    // Only a synchronous acknowledgement transfers completion from lifecycle events.
    return owner === "reply-dispatch" ? owner : undefined;
  };
}

export async function maybeUnbindStaleBoundConversations(params: {
  targetSessionKey: string;
  error: { code: string; message: string };
}): Promise<void> {
  if (
    params.error.code !== "ACP_SESSION_INIT_FAILED" ||
    !/(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found)/i.test(
      params.error.message,
    )
  ) {
    return;
  }
  try {
    const removed = await getSessionBindingService().unbind({
      targetSessionKey: params.targetSessionKey,
      reason: ACP_STALE_BINDING_UNBIND_REASON,
    });
    if (removed.length > 0) {
      logVerbose(
        `dispatch-acp: removed ${removed.length} stale bound conversation(s) for ${params.targetSessionKey} after ${params.error.code}: ${params.error.message}`,
      );
    }
  } catch (error) {
    logVerbose(
      `dispatch-acp: failed to unbind stale bound conversations for ${params.targetSessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}
