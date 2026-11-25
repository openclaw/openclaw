// Continues a session whose question outlived the Gateway restart that ended its tool call.
import type {
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/index.js";
import { formatRestartedQuestionResult } from "../agents/tools/ask-user-tool-normalization.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import type { QuestionObservation, ResumableQuestion } from "./question-manager.js";
import {
  questionBroadcastOptions,
  withPreparedQuestionSessionFacts,
} from "./question-session-access.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-sharing-authorization-async.js";

const log = createSubsystemLogger("gateway/questions");
type AskingSession = {
  agentId: string;
  sessionKey: string;
  operatorSource?: ResumableQuestion["operatorSource"];
};

/**
 * Sessions whose restart marker carries a pending question, added after live owners so
 * their resume and parked facts win. Graceful shutdown writes them; a crash loses them.
 */
export function questionSessions(questions: readonly ResumableQuestion[] = []) {
  return questions.map(({ agentId, sessionKey, operatorSource }) => ({
    agentId,
    sessionKey,
    operatorSource,
    needsResume: false,
  }));
}

/**
 * The pending questions a chat's restart marker carries. Questions from
 * child sessions never match their root's key: children do not resume independently.
 */
export function markerQuestions(
  questions: readonly ResumableQuestion[] | undefined,
  session: AskingSession,
): QuestionRecord[] {
  return (questions ?? []).flatMap(({ record, agentId, sessionKey }) =>
    agentId === session.agentId && sessionKey === session.sessionKey ? [record] : [],
  );
}

/**
 * Restores a restart marker's questions; true when any now waits to continue the session.
 * Clients that reconnected before this ran saw the question as missing, so it is announced
 * again, and its outcome is published, to the recipients the original request would reach.
 */
export async function restoreMarkerQuestions(
  context: GatewayRequestContext,
  session: AskingSession,
  marker: { questions?: QuestionRecord[]; operatorSource?: ResumableQuestion["operatorSource"] },
): Promise<boolean> {
  const manager = context.questionManager;
  const publish = async (
    event: string,
    payload: unknown,
    observation: QuestionObservation | null,
  ) => {
    try {
      await withPreparedQuestionSessionFacts(
        context,
        [session],
        ([prepared]) => {
          const cfg = context.getRuntimeConfig();
          let publishing = true;
          const recipients = questionBroadcastOptions({
            observation,
            prepared,
            ...(event === "question.requested" ? { expectedRecord: observation?.record } : {}),
            cfg,
            isPublishing: () => publishing,
          });
          try {
            context.broadcast(event, payload, {
              ...(cfg.gateway?.roles
                ? { sessionKeys: [session.sessionKey], agentId: session.agentId }
                : {}),
              ...recipients,
            });
          } finally {
            publishing = false;
          }
        },
        {
          assertCurrent: () => {
            if (!observation?.isCurrent()) {
              throw new Error("Question publication owner retired");
            }
          },
        },
      );
    } catch (error) {
      // Events are projections; the list/get owner retains the outcome if publication fails.
      log.warn(`Restored question event ${event} could not publish: ${formatErrorMessage(error)}`);
    }
  };
  const resumedSession = { ...session, operatorSource: marker.operatorSource };
  let restored = false;
  for (const record of marker.questions ?? []) {
    const onResolved = async (event: QuestionResolvedEvent, observation: QuestionObservation) => {
      await publish("question.resolved", event, observation);
      void resumeRestoredQuestion(context, resumedSession, observation.record);
    };
    if (
      manager?.restore(
        {
          record,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          operatorSource: marker.operatorSource,
        },
        onResolved,
      )
    ) {
      restored = true;
      await publish("question.requested", record, manager.observe(record.id, record));
    }
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
  const { agentId, sessionKey } = target;
  const contextKey = `question:${record.id}`;
  const text = formatRestartedQuestionResult(record);
  let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>>;
  try {
    await runWithGatewayDetachedWorkAdmission(async () => {
      // Select the chat's current transcript at admission; a reset does not change its key.
      const entry = await readSessionEntryReadOnlyInWorker({
        agentId,
        sessionKey,
        projection: "list",
      });
      if (!entry) {
        throw new Error("The asking conversation is unavailable.");
      }
      authority = await prepareSessionSystemTurnAuthority({
        context,
        agentId,
        sessionKey,
        sessionId: entry.sessionId,
        preserveRecordedSource: true,
        operatorSource: target.operatorSource,
      });
      const captured = await captureSessionEventTargetForHost(agentId, sessionKey, {
        operatorAuthority: authority?.authority,
      });
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
