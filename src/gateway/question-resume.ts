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
import type { ResumableQuestion } from "./question-manager.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

const log = createSubsystemLogger("gateway/questions");
type AskingSession = { agentId: string; sessionKey: string; sessionId: string };

/**
 * Sessions whose restart marker carries a pending question, added after live owners so
 * their resume and parked facts win. Graceful shutdown writes them; a crash loses them.
 */
export function questionSessions(questions: readonly ResumableQuestion[] = []) {
  return questions.flatMap(({ record, sessionId }) =>
    record.sessionKey
      ? [{ sessionKey: record.sessionKey, agentId: record.agentId, sessionId, needsResume: false }]
      : [],
  );
}

/**
 * The pending questions a session generation's restart marker carries. Questions from
 * child sessions never match their root's key: children do not resume independently.
 */
export function markerQuestions(
  questions: readonly ResumableQuestion[] | undefined,
  sessionKey: string,
  sessionId: string,
): QuestionRecord[] {
  return (questions ?? []).flatMap(({ record, sessionId: asked }) =>
    record.sessionKey === sessionKey && asked === sessionId ? [record] : [],
  );
}

/** Restores a restart marker's questions; true when any now waits to continue the session. */
export function restoreMarkerQuestions(
  context: GatewayRequestContext,
  session: AskingSession,
  marker: { questions?: QuestionRecord[] },
): boolean {
  const manager = context.questionManager;
  let restored = false;
  for (const record of marker.questions ?? []) {
    const continueSession = (outcome: QuestionRecord) => {
      void resumeRestoredQuestion(context, session, outcome);
    };
    if (!manager?.restore({ record, sessionId: session.sessionId }, continueSession)) {
      continue;
    }
    restored = true;
  }
  return restored;
}

/**
 * Admits one turn in the asking session, in the same sequence restart resume uses and
 * under the session's recorded principal. A failure leaves a visible transcript notice.
 */
async function resumeRestoredQuestion(
  context: GatewayRequestContext,
  target: AskingSession,
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
