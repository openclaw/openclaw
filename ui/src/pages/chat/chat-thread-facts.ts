import { messageClientSourcesKey } from "../../../../src/chat/message-client-source.js";
import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import type { ReplyAttributionFacts } from "./chat-thread-grouping-data.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";

/**
 * Transcript-wide facts of one build. An older-page prepend reuses retained rows
 * only while the new page cannot change them (see chat-thread-prepend.ts).
 */
export type ChatItemsFacts = ReplyAttributionFacts & {
  /** Content before live progress decides whether history loading can hide the indicator. */
  hasContentBeforeProgress?: boolean;
  /** Prepared beside the working indicator, before first text changes row membership. */
  streamOnset?: Extract<ChatItem, { kind: "stream" }>;
  /** Display history after heartbeat/commentary filtering and composition. */
  history?: readonly unknown[];
  /** First history message owning each persisted canvas identity or inline view key. */
  firsts: Map<string, unknown>;
  /** History messages whose divider key includes their transcript index. */
  indexedDividers: unknown[];
  /** Model-selection state entering this message. */
  probe?: unknown;
  modelBefore?: string;
};

/** Messages the transcript displays, in display order. */
export function displayChatHistory(
  props: { messages: unknown[]; persistCommentary?: boolean },
  activeCommentaryRunId?: string,
): unknown[] {
  return composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false ||
          !isKeyedAssistantStreamFallbackMessage(message) ||
          (activeCommentaryRunId !== undefined &&
            transcriptRunId(message) === activeCommentaryRunId)),
    ),
  );
}

export function sameFields<T extends object>(
  previous: T | null | undefined,
  next: T | null | undefined,
  fields: readonly (keyof T)[],
): boolean {
  return fields.every((field) => previous?.[field] === next?.[field]);
}

type RenderChatItem = ChatItem | MessageGroup;

type ReplySource = MessageGroup["replyToMessage"];

function sameReplySource(previous: ReplySource, next: ReplySource): boolean {
  return previous?.key === next?.key && previous?.message === next?.message;
}

function sameMessageGroup(previous: MessageGroup, next: MessageGroup): boolean {
  // Source message identity owns the row timestamp too: normalization supplies
  // Date.now() for missing timestamps, which must not churn stable rows.
  return (
    previous.role === next.role &&
    previous.senderLabel === next.senderLabel &&
    sameFields(previous.senderSession, next.senderSession, CHAT_ITEM_FIELDS.senderSession) &&
    messageClientSourcesKey(previous.sourceClients ?? []) ===
      messageClientSourcesKey(next.sourceClients ?? []) &&
    JSON.stringify(previous.sender) === JSON.stringify(next.sender) &&
    JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
    sameReplySource(previous.replyToMessage, next.replyToMessage) &&
    previous.replyPreviousMessageId === next.replyPreviousMessageId &&
    previous.replyShared === next.replyShared &&
    sameReplySource(previous.replyTurnSource, next.replyTurnSource) &&
    sameReplySource(previous.replyCurrentSource, next.replyCurrentSource) &&
    previous.isStreaming === next.isStreaming &&
    previous.visibleContent === next.visibleContent &&
    previous.runId === next.runId &&
    previous.messages.length === next.messages.length &&
    previous.messages.every((entry, index) => {
      const candidate = next.messages[index];
      return (
        candidate !== undefined &&
        entry.key === candidate.key &&
        entry.message === candidate.message &&
        JSON.stringify(entry.replyTarget) === JSON.stringify(candidate.replyTarget) &&
        entry.hasVisibleContent === candidate.hasVisibleContent
      );
    })
  );
}

export const CHAT_ITEM_FIELDS = {
  message: ["message"],
  notice: [
    "text",
    "label",
    "handoffBoundary",
    "startsTurn",
    "boundaryId",
    "timestamp",
    "systemEvent",
    "repeatCount",
  ],
  divider: [
    "compaction",
    "compactionId",
    "label",
    "metric",
    "description",
    "timestamp",
    "systemEvent",
  ],
  question: ["questionId", "startedAt"],
  senderSession: ["sessionKey", "agentId", "label"],
} as const;

export function sameChatItem(previous: RenderChatItem, next: RenderChatItem): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) {
    return false;
  }
  switch (next.kind) {
    case "group":
      return previous.kind === "group" && sameMessageGroup(previous, next);
    case "message":
      return previous.kind === "message" && sameFields(previous, next, CHAT_ITEM_FIELDS.message);
    case "notice":
      return (
        previous.kind === "notice" &&
        sameFields(previous, next, CHAT_ITEM_FIELDS.notice) &&
        sameFields(previous.modelChange, next.modelChange, ["from", "to"])
      );
    case "divider":
      return previous.kind === "divider" && sameFields(previous, next, CHAT_ITEM_FIELDS.divider);
    case "stream":
      return (
        previous.kind === "stream" &&
        previous.text === next.text &&
        previous.thinking === next.thinking &&
        previous.startedAt === next.startedAt &&
        previous.isStreaming === next.isStreaming &&
        JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
        sameReplySource(previous.replyToMessage, next.replyToMessage) &&
        previous.replyPreviousMessageId === next.replyPreviousMessageId &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "reading-indicator":
      return (
        previous.kind === "reading-indicator" &&
        previous.startedAt === next.startedAt &&
        previous.waitingOn === next.waitingOn &&
        previous.request?.askedAt === next.request?.askedAt &&
        previous.request?.runIds.join("\n") === next.request?.runIds.join("\n") &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "question":
      return previous.kind === "question" && sameFields(previous, next, CHAT_ITEM_FIELDS.question);
  }
  return false;
}
