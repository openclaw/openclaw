import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getRequesterProfile } from "../requester-profile.js";
import type { TemplateContext } from "../templating.js";
import {
  formatContextJson,
  formatContextJsonBlock,
  selectInboundHistoryContext,
} from "./channel-prompt-context.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { formatTelegramCurrentMessageContext } from "./inbound-meta.current-message.js";
import {
  formatActiveGoalContext,
  isChatWindowStructuredContext,
  normalizePromptMediaPath,
} from "./inbound-meta.js";
import {
  buildInboundHistoryMediaPromptPayload,
  buildLocationContextPayload,
} from "./inbound-meta.payloads.js";
import {
  normalizePromptMetadataString,
  normalizePromptMetadataStringArray,
  sanitizePromptBody,
  sanitizeTranscriptText,
} from "./inbound-meta.text.js";

export type CompactInboundContextProjection = {
  text: string;
  /** The same projection without the history a resumed turn already holds. */
  resumableText?: string;
  removedSessionMessages: number;
  deduplicatedMessages: number;
};

function readCompactMessageId(value: unknown): string | undefined {
  return isRecord(value) ? sanitizeTranscriptText(value["message_id"]) : undefined;
}

// A session row repeats a native row only when both carry the same timestamp and body, the key
// the transcript window merge uses. Display sanitization can collapse distinct bodies.
function readCompactDuplicateKey(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const timestamp = value["timestamp_ms"];
  const rawBody = value["body"];
  const body = typeof rawBody === "string" ? rawBody.trim() : "";
  return typeof timestamp === "number" && Number.isFinite(timestamp) && body
    ? `${timestamp}:${body}`
    : undefined;
}

function formatCompactHistoryMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readCompactMessageId(value);
  const sender = sanitizeTranscriptText(value["sender"]) ?? "unknown sender";
  const replyToId = sanitizeTranscriptText(value["reply_to_id"]);
  const body = sanitizeTranscriptText(value["body"], "body");
  const mediaType = sanitizeTranscriptText(value["media_type"]);
  const mediaPath =
    normalizePromptMediaPath(value["media_path"]) ?? sanitizeTranscriptText(value["media_ref"]);
  const media = mediaType ? `[${mediaType}${mediaPath ? ` ${mediaPath}` : ""}]` : undefined;
  const content = [body, media].filter(Boolean).join(" ");
  if (!content) {
    return undefined;
  }
  const prefix = [
    id ? `#${id}` : undefined,
    value["is_reply_target"] === true ? "[reply target]" : undefined,
    replyToId ? `->#${replyToId}` : undefined,
    `${sender}:`,
  ]
    .filter(Boolean)
    .join(" ");
  return `${prefix} ${content}`;
}

/** Builds the allowlisted inbound context used by compact context serialization. */
export function buildCompactInboundUserContextPrefix(
  ctx: TemplateContext,
  sessionEntry?: SessionEntry,
): CompactInboundContextProjection {
  const blocks: string[] = [];
  const chatType = normalizeChatType(ctx.ChatType);
  const isDirect = !chatType || chatType === "direct";
  const messageId =
    normalizePromptMetadataString(ctx.MessageSid) ??
    normalizePromptMetadataString(ctx.MessageSidFull);
  const senderName =
    normalizePromptMetadataString(ctx.SenderName) ??
    normalizePromptMetadataString(ctx.SenderUsername);
  const senderId = normalizePromptMetadataString(ctx.SenderId);
  const requester = getRequesterProfile(ctx);
  const compactFacts = {
    // Host tools tell the model to pass requester_profile.id (assign_owner, steering).
    requester_profile: requester
      ? { id: requester.id, display_name: sanitizeTranscriptText(requester.displayName) }
      : undefined,
    message_id: messageId,
    sender: !isDirect
      ? {
          name: senderName,
          id: senderId,
          is_bot: ctx.SenderIsBot === true ? true : undefined,
        }
      : undefined,
    reply_to_id: normalizePromptMetadataString(ctx.ReplyToId),
    thread_id:
      ctx.MessageThreadId != null
        ? normalizePromptMetadataString(String(ctx.MessageThreadId))
        : undefined,
    thread_label: normalizePromptMetadataString(ctx.ThreadLabel),
    was_mentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
    explicitly_mentioned_bot:
      typeof ctx.ExplicitlyMentionedBot === "boolean" ? ctx.ExplicitlyMentionedBot : undefined,
    mentioned_user_ids: normalizePromptMetadataStringArray(ctx.MentionedUserIds),
    mentioned_subteam_ids: normalizePromptMetadataStringArray(ctx.MentionedSubteamIds),
    mention_source: normalizePromptMetadataString(ctx.MentionSource),
  };
  if (Object.values(compactFacts).some((value) => value !== undefined)) {
    blocks.push(`Context: ${formatContextJson(compactFacts)}`);
  }

  // A channel that quotes only through ReplyChain (Nextcloud Talk) has no ReplyToBody. Its
  // nearest entry stands in as the reply target, like the reply chain of the default context.
  const replyChainEntry = ctx.ReplyChain?.find((entry) =>
    Boolean(sanitizeTranscriptText(entry.body, "body")),
  );
  const replyBody =
    sanitizeTranscriptText(ctx.ReplyToBody, "body") ??
    sanitizeTranscriptText(replyChainEntry?.body, "body");
  const replySender =
    normalizePromptMetadataString(ctx.ReplyToSender) ??
    (ctx.ReplyToBody ? undefined : normalizePromptMetadataString(replyChainEntry?.sender));
  if (replyBody || replySender) {
    blocks.push(
      `Reply target: ${formatContextJson({
        sender: replySender,
        body: replyBody,
        is_quote:
          ctx.ReplyToIsQuote === true || (!ctx.ReplyToBody && replyChainEntry?.isQuote === true)
            ? true
            : undefined,
      })}`,
    );
  }

  const threadStarterBody = sanitizePromptBody(ctx.ThreadStarterBody);
  if (threadStarterBody) {
    blocks.push(`Thread starter: ${formatContextJson({ body: threadStarterBody })}`);
  }

  const forwardedFrom = normalizePromptMetadataString(ctx.ForwardedFrom);
  if (forwardedFrom) {
    blocks.push(
      `Forwarded: ${formatContextJson({
        from: forwardedFrom,
        type: normalizePromptMetadataString(ctx.ForwardedFromType),
        username: normalizePromptMetadataString(ctx.ForwardedFromUsername),
        title: normalizePromptMetadataString(ctx.ForwardedFromTitle),
      })}`,
    );
  }

  const location = buildLocationContextPayload(ctx);
  if (location) {
    blocks.push(`Location: ${formatContextJson(location)}`);
  }

  const seenMessageIds = new Set<string>();
  const historyLines: string[] = [];
  let removedSessionMessages = 0;
  let deduplicatedMessages = 0;
  const addHistoryMessage = (value: unknown, nativeKeys?: ReadonlySet<string>) => {
    const id = readCompactMessageId(value);
    if (id?.startsWith("session:")) {
      // A window row that only the session transcript holds (a delivered cron close-out, a
      // message-tool source reply) is not replayed to the provider, so it stays. Only a row
      // that repeats a native row of the same window, same timestamp and body, is a duplicate.
      const key = readCompactDuplicateKey(value);
      if (!nativeKeys || (key && nativeKeys.has(key))) {
        removedSessionMessages += 1;
        return;
      }
    }
    if (id && seenMessageIds.has(id)) {
      deduplicatedMessages += 1;
      return;
    }
    const line = formatCompactHistoryMessage(value);
    if (!line) {
      return;
    }
    if (id) {
      seenMessageIds.add(id);
    }
    historyLines.push(line);
  };

  for (const entry of ctx.ChannelStructuredContext ?? []) {
    if (isChatWindowStructuredContext(entry)) {
      const windowMessages: unknown[] = Array.isArray(entry.payload["messages"])
        ? entry.payload["messages"]
        : [];
      const nativeKeys = new Set<string>();
      for (const message of windowMessages) {
        if (readCompactMessageId(message)?.startsWith("session:")) {
          continue;
        }
        const key = readCompactDuplicateKey(message);
        if (key) {
          nativeKeys.add(key);
        }
      }
      for (const message of windowMessages) {
        addHistoryMessage(message, nativeKeys);
      }
      continue;
    }
    blocks.push(
      formatContextJsonBlock(`${sanitizeTranscriptText(entry.label) ?? "Channel context"}:`, {
        type: normalizePromptMetadataString(entry.type),
        payload: entry.payload,
      }),
    );
  }

  const boundedHistory = selectInboundHistoryContext(ctx).boundedHistory;
  // A session row of this history is removed only when a native row of the same history repeats
  // its timestamp and body. A transcript-only row (a close-out, a message-tool reply) is not
  // replayed.
  const nativeHistoryKeys = new Set<string>();
  for (const entry of boundedHistory) {
    if (entry.messageId?.startsWith("session:")) {
      continue;
    }
    const key = readCompactDuplicateKey({ timestamp_ms: entry.timestamp, body: entry.body });
    if (key) {
      nativeHistoryKeys.add(key);
    }
  }
  for (const entry of boundedHistory) {
    addHistoryMessage(
      {
        message_id: entry.messageId,
        sender: entry.sender,
        body: entry.body,
        timestamp_ms: entry.timestamp,
        media_type:
          buildInboundHistoryMediaPromptPayload(entry.media)
            .map((media) => media["content_type"])
            .filter((value): value is string => typeof value === "string")
            .join(", ") || undefined,
      },
      nativeHistoryKeys,
    );
  }
  const historyBlockIndex = historyLines.length > 0 ? blocks.length : -1;
  if (historyLines.length > 0) {
    blocks.push(["History:", ...historyLines].join("\n"));
  }

  // Like the default context, the goal block and the current-message block stay outside the
  // marked unit, separated by a blank line, so stripping the marked block never takes user text.
  const trailingBlocks = [
    formatActiveGoalContext(sessionEntry),
    formatTelegramCurrentMessageContext(ctx),
  ].filter((block): block is string => Boolean(block));

  // One marked header lets every inbound-context stripper find the block. The blocks below it
  // have no blank lines, so a stripper removes the header and the block as one unit.
  const render = (parts: string[]) =>
    [
      parts.some(Boolean)
        ? [markInboundContextLabel("Context facts:"), ...parts].filter(Boolean).join("\n")
        : "",
      ...trailingBlocks,
    ]
      .filter(Boolean)
      .join("\n\n");
  return {
    text: render(blocks),
    resumableText: render(blocks.filter((_, index) => index !== historyBlockIndex)),
    removedSessionMessages,
    deduplicatedMessages,
  };
}
