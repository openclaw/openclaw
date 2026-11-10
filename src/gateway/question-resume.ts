// Continues a session whose question outlived the Gateway restart that ended its tool call.
import type { QuestionRecord } from "../../packages/gateway-protocol/src/index.js";
import { formatRestartedQuestionResult } from "../agents/tools/ask-user-tool-normalization.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

const log = createSubsystemLogger("gateway/questions");

/**
 * Admits one turn in the asking session, in the same sequence restart resume uses and
 * under the session's recorded principal. A failure leaves a visible transcript notice.
 */
export async function resumeRestoredQuestion(
  context: GatewayRequestContext,
  target: { agentId: string; sessionKey: string; sessionId: string },
  record: QuestionRecord,
): Promise<void> {
  const { agentId, sessionKey, sessionId } = target;
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
      const captured = await captureSessionEventTargetForHost(agentId, sessionKey, {
        operatorAuthority: authority?.authority,
      });
      if (captured.sessionId !== sessionId) {
        throw new Error("the conversation was reset");
      }
      const receipt = withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
        enqueueSessionEventForHost(text, {
          agentId,
          sessionKey,
          source: "tool_handoff",
          contextKey,
          expectedTarget: captured,
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
    }
  }
}
