import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import {
  createCurrentUserProfileMessageProjector,
  projectChatDisplayMessage,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import {
  attachOpenClawTranscriptMeta,
  readTranscriptMessageIdempotencyKey,
} from "./session-transcript-entry-message.js";

export type SessionMessageProjectionState = {
  assistantErrorPending: boolean;
  turnBoundaryPending: boolean;
};

function readTranscriptMessageSenderIsOwner(message: unknown): boolean | undefined {
  const openclaw = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const value = openclaw?.senderIsOwner;
  return typeof value === "boolean" ? value : undefined;
}

/** Project one transcript message into the exact payload emitted as session.message. */
export function projectSessionMessagePayload(params: {
  agentId?: string;
  historyDelta?: boolean;
  message: unknown;
  messageId?: string;
  messageSeq?: number;
  transcriptPosition?: TranscriptDisplayPosition;
  projectionState?: SessionMessageProjectionState;
  projectCurrentUserProfile?: (message: Record<string, unknown>) => Record<string, unknown>;
  runId?: string;
  sessionKey: string;
  sessionSnapshot?: Record<string, unknown>;
  subagentCoordination?: SubagentCoordinationDisplayResolver;
}): {
  payload?: Record<string, unknown>;
  projectionState: SessionMessageProjectionState;
  requiresHistoryReset?: true;
} {
  const idempotencyKey = readTranscriptMessageIdempotencyKey(params.message);
  const senderIsOwner = readTranscriptMessageSenderIsOwner(params.message);
  const rawMessage = attachOpenClawTranscriptMeta(params.message, {
    // Placement comes from the selected reader snapshot, never persisted/imported metadata.
    transcriptPosition: params.transcriptPosition,
    ...(params.messageId ? { id: params.messageId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(params.messageSeq !== undefined ? { seq: params.messageSeq } : {}),
  });
  const historyProjection = params.historyDelta
    ? projectChatDisplayMessagesWithState([rawMessage], {
        ...params.projectionState,
        subagentCoordination: params.subagentCoordination,
        includeCommentaryFallbacks: true,
        activity: false,
      })
    : undefined;
  if (
    historyProjection?.messages.some(
      (message) => asOptionalRecord(message.openclawStreamFallback)?.source === "segment",
    )
  ) {
    // A single-message envelope cannot carry a commentary/tool split; let full history
    // reconcile both rows.
    return {
      projectionState: {
        assistantErrorPending: historyProjection.assistantErrorPending,
        turnBoundaryPending: historyProjection.turnBoundaryPending,
      },
      requiresHistoryReset: true,
    };
  }
  // A fallback can consume a pending turn boundary before final sanitation removes it.
  // Reproject those rows from the incoming state, even when no segment remains visible.
  const projected =
    historyProjection && !historyProjection.commentaryFallbacksObserved
      ? historyProjection
      : params.projectionState
        ? projectChatDisplayMessagesWithState([rawMessage], {
            assistantErrorPending: params.projectionState.assistantErrorPending,
            turnBoundaryPending: params.projectionState.turnBoundaryPending,
            activity: false,
            subagentCoordination: params.subagentCoordination,
          })
        : {
            messages: [
              projectChatDisplayMessage(rawMessage, {
                subagentCoordination: params.subagentCoordination,
              }),
            ],
            assistantErrorPending: false,
            turnBoundaryPending: false,
          };
  const projectionState = {
    assistantErrorPending: projected.assistantErrorPending,
    turnBoundaryPending: projected.turnBoundaryPending,
  };
  const message = projected.messages[0];
  if (!message) {
    return { projectionState };
  }
  const projectCurrentUserProfile =
    params.projectCurrentUserProfile ??
    createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  const projectedMessage = projectCurrentUserProfile(message);
  params.subagentCoordination?.assertCurrent?.();
  return {
    payload: {
      sessionKey: params.sessionKey,
      ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      message: projectedMessage,
      ...(params.messageId ? { messageId: params.messageId } : {}),
      ...(params.messageSeq !== undefined ? { messageSeq: params.messageSeq } : {}),
      ...params.sessionSnapshot,
      ...(params.runId ? { runId: params.runId } : {}),
    },
    projectionState,
  };
}
