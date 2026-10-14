import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import { warnLegacyAgentRunStart } from "../../auto-reply/agent-run-start.js";
import type { PreparedReplyTranscriptStart } from "../../auto-reply/get-reply-options.types.js";
import type { SessionTranscriptWatermark } from "../../config/sessions/session-accessor.sqlite-transcript-watermark-read.js";
import { readSessionTranscriptWatermark } from "../../config/sessions/session-accessor.sqlite-transcript-watermark.js";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";

/** Match prepared evidence to the current session without querying its transcript. */
export function resolveChatReplyTranscriptStart(
  session: Pick<PreparedReplyTranscriptStart, "agentId" | "sessionKey"> & {
    backingSessionId?: string;
  },
  current: { entry?: { sessionId?: string }; storePath: string },
  prepared: PreparedReplyTranscriptStart | null,
) {
  const scope = {
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    sessionId: current.entry?.sessionId ?? session.backingSessionId,
    storePath: current.storePath,
  };
  if (
    prepared &&
    (prepared.agentId !== scope.agentId ||
      prepared.sessionId !== scope.sessionId ||
      prepared.sessionKey !== scope.sessionKey ||
      !isSameOpenClawAgentDatabasePath(prepared.storePath, scope.storePath))
  ) {
    return undefined;
  }
  const watermark = prepared ?? { generation: null, maxSeq: null };
  return {
    sessionId: scope.sessionId,
    generation: watermark.generation,
    afterSeq: watermark.maxSeq ?? 0,
  };
}

/** Released SDK producers may still omit transcript facts until the next SDK major. */
export function resolveLegacyChatReplyTranscriptStart(
  session: Parameters<typeof resolveChatReplyTranscriptStart>[0],
  current: Parameters<typeof resolveChatReplyTranscriptStart>[1],
) {
  warnLegacyAgentRunStart();
  const sessionId = current.entry?.sessionId ?? session.backingSessionId;
  const prepared = sessionId
    ? {
        agentId: session.agentId,
        sessionId,
        sessionKey: session.sessionKey,
        storePath: current.storePath,
        ...readSessionTranscriptWatermark({
          agentId: session.agentId,
          sessionId,
          sessionKey: session.sessionKey,
          storePath: current.storePath,
        }),
      }
    : null;
  return resolveChatReplyTranscriptStart(session, current, prepared);
}

/** Decide receipt coverage from one current anchor snapshot and the observed transcript bounds. */
export function resolveChatReplyDeliveryFromAnchors(params: {
  facts: SessionTranscriptAnchorFacts;
  admissionId: string;
  inputId: string;
  messageId: string;
  afterSeq: number;
  watermark: SessionTranscriptWatermark;
  currentWatermark: SessionTranscriptWatermark;
}): ReplyDeliveryState | undefined {
  const { facts, afterSeq, watermark, currentWatermark } = params;
  const admitted = facts.anchors.find((entry) => entry.entryId === params.admissionId);
  const input = facts.anchors.find((entry) => entry.entryId === params.inputId);
  const anchor = facts.anchors.find((entry) => entry.entryId === params.messageId);
  if (!admitted || !input) {
    return "missing";
  }
  if (
    !anchor ||
    anchor.rawSeq <= afterSeq ||
    anchor.activeMessagePosition <= input.activeMessagePosition
  ) {
    return undefined;
  }
  if (
    facts.tail?.entries.some(
      (entry) =>
        entry.role === "user" &&
        entry.anchor &&
        entry.anchor.activeMessagePosition > anchor.activeMessagePosition,
    )
  ) {
    return "missing";
  }
  if (
    currentWatermark.generation !== watermark.generation ||
    currentWatermark.maxSeq !== watermark.maxSeq ||
    anchor.generation !== currentWatermark.generation ||
    facts.tail?.lastSeq !== currentWatermark.maxSeq
  ) {
    return "pending";
  }
  return "delivered";
}
