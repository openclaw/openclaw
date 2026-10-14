import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptDisplayDeltaResult } from "../../config/sessions/session-accessor.sqlite-history-query.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import {
  projectAgentHistoryActivity,
  type AgentHistoryActivity,
} from "../../infra/agent-activity-events.js";
import { jsonUtf8BytesOrInfinity } from "../../infra/json-utf8-bytes.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { prepareForwardedMessageCronJobNameResolver } from "../chat-display-projection.history.js";
import {
  createCurrentUserProfileMessageProjector,
  isAssistantTtsSupplementMessage,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import {
  createPreparedSessionHistorySubagentProjection,
  isAppendOnlySessionHistoryDelta,
} from "../session-history-delta-visibility.js";
import { projectTranscriptEntryMessage } from "../session-transcript-entry-message.js";
import { createSessionActorTranscriptReader } from "../session-transcript-memory-reader.js";
import {
  projectSessionMessagePayload,
  type SessionMessageProjectionState,
} from "../session-transcript-message.js";
import type { SubagentCoordinationDisplayResolver } from "../session-transcript-read.types.js";
import {
  chatHistoryActivityBytes,
  createChatHistoryActivityProjection,
  createChatHistoryDeltaByteCounter,
} from "./chat-history-budget.js";

const CHAT_HISTORY_DELTA_MAX_EVENTS = 200;
const CHAT_HISTORY_DELTA_MAX_BYTES = 1_000_000;

type ChatHistoryDeltaRead =
  | { kind: "reset" }
  | {
      activeLeafEntryId: string | null;
      deltaCursor: string;
      kind: "delta";
      messages: Record<string, unknown>[];
      activity: AgentHistoryActivity[];
      messagesBytes: number;
      activityBytes: number;
    };

type ChatHistoryDeltaParams = {
  agentId: string;
  cursor: string;
  maxBytes?: number;
  toolResultMaxChars?: number;
  scope: SessionTranscriptReadScope;
  sessionKey: string;
  sessionSnapshot: Record<string, unknown>;
};

function chatHistoryDeltaLimits(params: ChatHistoryDeltaParams) {
  return {
    cursor: params.cursor,
    maxBytes: Math.min(params.maxBytes ?? Infinity, CHAT_HISTORY_DELTA_MAX_BYTES),
    maxEvents: CHAT_HISTORY_DELTA_MAX_EVENTS,
  };
}

export async function readChatHistoryDelta(
  params: ChatHistoryDeltaParams & { incognito?: boolean },
  signal?: AbortSignal,
): Promise<ChatHistoryDeltaRead> {
  signal?.throwIfAborted();
  const memory = captureSessionActorTranscriptRead(params.scope, signal);
  if (memory) {
    if (memory.missing) {
      return { kind: "reset" };
    }
    const delta = await memory.read("session.history.delta", {
      options: chatHistoryDeltaLimits(params),
    });
    const readers = createSessionActorTranscriptReader(memory);
    if (delta.kind === "page") {
      await readers.prepareVisibility(
        delta.events.flatMap((row) =>
          row.messageSeq === undefined
            ? []
            : [projectTranscriptEntryMessage(row.event, row.messageSeq, row.displayPosition)],
        ),
      );
    }
    const result = await projectChatHistoryDelta(params, delta, readers.subagentCoordination);
    signal?.throwIfAborted();
    memory.assertCurrent();
    return result;
  }
  if (params.incognito || isIncognitoSessionKey(params.sessionKey)) {
    return { kind: "reset" };
  }
  const target: SessionTranscriptReadScope = {
    ...params.scope,
    sessionEntry: params.scope.sessionEntry
      ? { sessionId: params.scope.sessionEntry.sessionId }
      : undefined,
  };
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  const result = await readSessionHistoryPageInWorker(
    {
      kind: "delta",
      params: {
        target,
        limits: chatHistoryDeltaLimits(params),
      },
    },
    signal,
  );
  return projectChatHistoryDelta(
    params,
    result.delta,
    createPreparedSessionHistorySubagentProjection(
      result.subagentCoordination,
      result.assertCurrent,
    ),
  );
}

async function projectChatHistoryDelta(
  params: ChatHistoryDeltaParams,
  result: SessionTranscriptDisplayDeltaResult,
  subagentCoordination: SubagentCoordinationDisplayResolver,
): Promise<ChatHistoryDeltaRead> {
  const maxBytes = Math.min(params.maxBytes ?? Infinity, CHAT_HISTORY_DELTA_MAX_BYTES);
  subagentCoordination.assertCurrent?.();
  if (!isAppendOnlySessionHistoryDelta(result)) {
    return { kind: "reset" };
  }
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
    result.events.flatMap((row) =>
      row.messageSeq === undefined
        ? []
        : [projectTranscriptEntryMessage(row.event, row.messageSeq, row.displayPosition)],
    ),
  );
  subagentCoordination.assertCurrent?.();
  let projectionState: SessionMessageProjectionState = {
    assistantErrorPending: false,
    turnBoundaryPending: false,
  };
  const projectCurrentUserProfile = createCurrentUserProfileMessageProjector(
    resolveCurrentUserProfileDisplay,
  );
  const messages: Record<string, unknown>[] = [];
  const activityMessages: Array<{ messageId: string; message: unknown }> = [];
  // Include array brackets and separators without serializing the whole page.
  let messagesBytes = 2;
  const envelopeBytes =
    result.events.length > 1
      ? createChatHistoryDeltaByteCounter(params.sessionSnapshot)
      : undefined;
  for (const row of result.events) {
    if (row.messageSeq === undefined) {
      continue;
    }
    const entryMessage = projectTranscriptEntryMessage(
      row.event,
      row.messageSeq,
      row.displayPosition,
    );
    if (!entryMessage) {
      continue;
    }
    if (
      isOpenClawDeliveryMirrorAssistantMessage(entryMessage) &&
      asOptionalRecord(asOptionalRecord(entryMessage)?.openclawDeliveryMirror)?.kind ===
        "channel-final"
    ) {
      // Mirror suppression needs the preceding reply, which can be before this cursor.
      return { kind: "reset" };
    }
    if (isAssistantTtsSupplementMessage(entryMessage)) {
      // Full history owns merging audio into a reply that can precede this cursor.
      return { kind: "reset" };
    }
    const messageId = asOptionalRecord(row.event)?.id;
    const projected = projectSessionMessagePayload({
      agentId: params.agentId,
      historyDelta: true,
      toolResultMaxChars: params.toolResultMaxChars,
      message: entryMessage,
      ...(typeof messageId === "string" && messageId ? { messageId } : {}),
      messageSeq: row.messageSeq,
      transcriptPosition: row.displayPosition,
      projectionState,
      projectCurrentUserProfile,
      subagentCoordination,
      resolveCronJobName,
      sessionKey: params.sessionKey,
      sessionSnapshot: params.sessionSnapshot,
    });
    if (projected.requiresHistoryReset) {
      return { kind: "reset" };
    }
    projectionState = projected.projectionState;
    // Recovery can remove this row from history, which an append-only delta cannot express.
    // Keep the last accepted cursor before the error and let a full tail own reconciliation.
    if (projectionState.assistantErrorPending) {
      return { kind: "reset" };
    }
    if (projected.payload) {
      messagesBytes +=
        (envelopeBytes
          ? envelopeBytes(projected.payload)
          : jsonUtf8BytesOrInfinity(projected.payload)) + (messages.length > 0 ? 1 : 0);
      if (messagesBytes > maxBytes) {
        return { kind: "reset" };
      }
      messages.push(projected.payload);
      if (typeof messageId === "string") {
        activityMessages.push({ messageId, message: entryMessage });
      }
    }
  }
  subagentCoordination.assertCurrent?.();
  const activity = [
    ...createChatHistoryActivityProjection(
      messages.map((envelope) => envelope.message),
      projectAgentHistoryActivity(activityMessages),
    ).values(),
  ];
  const activityBytes = chatHistoryActivityBytes(activity);
  if (messagesBytes + activityBytes > maxBytes) {
    return { kind: "reset" };
  }
  return {
    activeLeafEntryId: result.activeLeafEntryId,
    deltaCursor: result.cursor,
    kind: "delta",
    activity,
    messages: composeTranscriptDisplay(messages, (envelope) => envelope.message),
    messagesBytes,
    activityBytes,
  };
}
