import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalRecord,
  asOptionalObjectRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
  readTerminalSourceReplyDeliveryMirror,
  resolveAssistantMessagePhase,
} from "../../shared/chat-message-content.js";
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-projection-read.js";
import {
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
} from "./session-accessor.sqlite-visible-cursor.js";

function readPreferredUpstreamUserText(message: {
  __openclaw?: unknown;
}): string | null | undefined {
  const meta = asOptionalObjectRecord(message["__openclaw"]);
  if (typeof meta?.upstreamUserText === "string") {
    return meta.upstreamUserText.trim();
  }
  return meta?.mirrorOrigin ? null : undefined;
}

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

/** Internal channel-history evidence, not part of the Plugin SDK text projection. */
export type SessionRecentConversationTurn = SessionRecentConversationText & {
  messageId?: string;
  isCompletedAnswer?: true;
};

export type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  deliveryOnly?: boolean;
  includeCronDirectDeliveryContext?: boolean;
  includeMessageToolSourceReplies?: boolean;
  limit?: number;
  minTimestampMs?: number;
  role?: "user" | "assistant";
  preferUpstreamUserText?: boolean;
};

export type ReadRecentSessionConversationTurnOptions = ReadRecentSessionConversationTextOptions & {
  includeTurnIdentity?: boolean;
  /** Internal history candidates; stop at their newest occurrences within the bounded tail. */
  candidateMessageIds?: readonly string[];
};

type ExtractedRecentConversationText = {
  deliveryOnly: boolean;
  entry: SessionRecentConversationTurn;
};

function extractRecentConversationText(
  event: TranscriptEvent,
  options: ReadRecentSessionConversationTurnOptions = {},
): ExtractedRecentConversationText | undefined {
  const parsed = asOptionalRecord(event);
  const message = asOptionalRecord(parsed?.message);
  if (
    !message ||
    (message.role !== "user" && message.role !== "assistant") ||
    (options.role && message.role !== options.role)
  ) {
    return undefined;
  }
  const deliveryMirror = message.openclawDeliveryMirror;
  const includeCronDirectDeliveryContext =
    options.includeCronDirectDeliveryContext === true &&
    deliveryMirror !== null &&
    typeof deliveryMirror === "object" &&
    !Array.isArray(deliveryMirror) &&
    "kind" in deliveryMirror &&
    deliveryMirror.kind === CRON_DIRECT_DELIVERY_CONTEXT_KIND;
  const transcriptOnlyAssistant =
    message.role === "assistant" && isTranscriptOnlyOpenClawAssistantMessage(message);
  const deliveryOnly =
    transcriptOnlyAssistant &&
    (includeCronDirectDeliveryContext ||
      Boolean(
        options.includeMessageToolSourceReplies && readTerminalSourceReplyDeliveryMirror(message),
      ));
  if (transcriptOnlyAssistant && !deliveryOnly) {
    return undefined;
  }
  const upstreamUserText =
    options.preferUpstreamUserText && message.role === "user"
      ? readPreferredUpstreamUserText(message)
      : undefined;
  if (upstreamUserText === null) {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : (upstreamUserText ?? extractFirstTextBlock(message)?.trim());
  if (!text && !(options.includeTurnIdentity && message.role === "user")) {
    return undefined;
  }
  const provenance = asOptionalRecord(message.provenance);
  const timestamp = asFiniteNumber(message.timestamp);
  const entry: SessionRecentConversationTurn = {
    ...(typeof parsed?.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    // Image-only users still separate an earlier request from a later answer.
    text: text ?? "",
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
  if (options.includeTurnIdentity) {
    const metadata = asOptionalRecord(message["__openclaw"]);
    const messageId =
      message.role === "user" ? asOptionalRecord(metadata?.transport)?.messageId : undefined;
    if (typeof messageId === "string" && messageId) {
      entry.messageId = messageId;
    }
    // Native narration can stop too; only a terminal mirror or final reply proves completion.
    if (
      message.role === "assistant" &&
      (readTerminalSourceReplyDeliveryMirror(message) ||
        (message.stopReason === "stop" &&
          !message.errorMessage &&
          resolveAssistantMessagePhase(message) !== "commentary" &&
          message.openclawStreamFallback === undefined &&
          message.openclawAsyncDelivery === undefined &&
          (metadata?.mirrorOrigin === undefined || metadata.runTerminal === true)))
    ) {
      entry.isCompletedAnswer = true;
    }
  }
  return { deliveryOnly, entry };
}

/** Select recent text inside the caller's single transcript snapshot. */
export function readRecentTranscriptConversationText(
  readPage: (
    options: SessionTranscriptBoundedMessageTailOptions,
  ) => SessionTranscriptBoundedMessageTailPage,
  options: ReadRecentSessionConversationTurnOptions = {},
): SessionRecentConversationTurn[] {
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const pageSize = 250;
  const pending =
    options.includeTurnIdentity && options.candidateMessageIds
      ? new Set(options.candidateMessageIds)
      : undefined;
  // Reuse the transcript reader's physical-message ceiling. Missing candidates
  // retain their platform context instead of turning this into an unbounded scan.
  const maxMessages = pending ? MAX_VISIBLE_MESSAGE_MAX_MESSAGES : Number.POSITIVE_INFINITY;
  let remainingBytes = MAX_VISIBLE_MESSAGE_MAX_BYTES;
  const recent: ExtractedRecentConversationText[] = [];
  for (
    let offset = 0;
    offset < maxMessages && (pending ? pending.size > 0 : recent.length < limit);
    offset += pageSize
  ) {
    const page = readPage({
      maxMessages: Math.min(pageSize, maxMessages - offset),
      maxBytes: pending ? remainingBytes : Number.MAX_SAFE_INTEGER,
      offset,
    });
    // Never bridge a skipped message: an omitted user may separate this answer
    // from a candidate. The byte-limited reader can also return older sparse rows.
    const events = pending
      ? page.events.slice(page.events.length - page.newestContiguousEventCount)
      : page.events;
    for (const event of events.toReversed()) {
      const extracted = extractRecentConversationText(event.event, options);
      if (
        extracted &&
        (options.beforeTimestampMs === undefined ||
          extracted.entry.timestamp === undefined ||
          extracted.entry.timestamp < options.beforeTimestampMs) &&
        (options.minTimestampMs === undefined ||
          extracted.entry.timestamp === undefined ||
          extracted.entry.timestamp >= options.minTimestampMs)
      ) {
        // Preserve intervening user rows: they prevent unrelated later answers
        // from suppressing an earlier unanswered candidate.
        recent.push(extracted);
        if (extracted.entry.messageId) {
          pending?.delete(extracted.entry.messageId);
        }
        if (pending ? pending.size === 0 : recent.length >= limit) {
          break;
        }
      }
    }
    if (pending) {
      remainingBytes -= page.serializedBytes;
      if (remainingBytes <= 0 || page.newestContiguousEventCount < page.scannedMessages) {
        break;
      }
    }
    if (offset + page.scannedMessages >= page.totalMessages) {
      break;
    }
  }
  return recent
    .toReversed()
    .flatMap(({ deliveryOnly, entry }) => (!options.deliveryOnly || deliveryOnly ? [entry] : []));
}
