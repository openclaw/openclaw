// Continues a session whose question outlived the Gateway restart that ended its tool call.
import { formatRestartedQuestionResult } from "../agents/tools/ask-user-tool-normalization.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { RestoredQuestion } from "./question-manager.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

const log = createSubsystemLogger("gateway/questions");

/**
 * Admits one turn in the asking session, in the same sequence restart resume uses and
 * under the session's recorded principal. A failure leaves a visible notice and keeps
 * the row for the next start, unless the conversation was reset since the question.
 */
export async function resumeRestoredQuestion(
  context: GatewayRequestContext,
  { stored, onAdopted }: RestoredQuestion,
): Promise<void> {
  const { record, sessionId } = stored;
  const sessionKey = record.sessionKey ?? "";
  const agentId = record.agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? "";
  const contextKey = `question:${record.id}`;
  const text = formatRestartedQuestionResult(record);
  let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>>;
  try {
    await runWithGatewayDetachedWorkAdmission(async () => {
      authority = await prepareSessionSystemTurnAuthority({
        context,
        agentId,
        sessionKey,
        sessionId,
        preserveRecordedSource: true,
      });
      const target = await captureSessionEventTargetForHost(agentId, sessionKey, {
        operatorAuthority: authority?.authority,
      });
      if (target.sessionId !== sessionId) {
        throw new Error("the conversation was reset");
      }
      const receipt = withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
        enqueueSessionEventForHost(text, {
          agentId,
          sessionKey,
          source: "tool_handoff",
          contextKey,
          expectedTarget: target,
          onAdopted,
        }),
      );
      const retained = authority;
      authority = undefined;
      void receipt.settled.finally(() => retained?.release()).catch(() => {});
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        throw accepted.cause ?? new Error(accepted.error);
      }
    }, "question:restored-continuation");
  } catch (error) {
    authority?.release();
    const reason = formatErrorMessage(error);
    log.warn(`question ${record.id} could not continue its session: ${reason}`);
    const reset = await captureSessionEventTargetForHost(agentId, sessionKey).then(
      (target) => target.sessionId !== sessionId,
      () => false,
    );
    const { appendAssistantMessageToSessionTranscript } =
      await import("../config/sessions/transcript.js");
    const notice = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      idempotencyKey: `${contextKey}:undelivered`,
      text:
        `${text}\n\nThis could not continue the conversation automatically: ${reason}. ` +
        "Send a message to continue from it; do not ask again.",
    }).catch((noticeError: unknown) => ({ ok: false, reason: formatErrorMessage(noticeError) }));
    if (!notice.ok) {
      log.warn(`question ${record.id} notice failed: ${notice.reason}`);
    } else if (reset) {
      await onAdopted();
    }
  }
}
