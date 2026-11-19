import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isSessionBoundaryCommandText } from "../../auto-reply/command-detection.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  readRecentUserAssistantTextForSession,
  readRecentUserAssistantTurnsForSession,
} from "../../config/sessions/transcript.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { stripInlineDirectiveTagsForDelivery } from "../../utils/directive-tags.js";

type PromptMessage = Record<string, unknown>;
type TranscriptMessage = {
  entry: HistoryEntry;
  role: "assistant" | "user";
  transcriptId?: string;
};

function messageKeys(message: PromptMessage): string[] {
  const id = typeof message.message_id === "string" ? message.message_id.trim() : "";
  const body = typeof message.body === "string" ? message.body.trim() : "";
  const timestamp = message.timestamp_ms;
  return [
    id ? `id:${id}` : "",
    body && typeof timestamp === "number" ? `text:${timestamp}:${body}` : "",
  ].filter(Boolean);
}

function historyMessage(entry: HistoryEntry): PromptMessage {
  return {
    ...(entry.messageId ? { message_id: entry.messageId } : {}),
    sender: entry.sender,
    ...(entry.timestamp !== undefined ? { timestamp_ms: entry.timestamp } : {}),
    body: entry.body,
  };
}

function compareMessages(left: PromptMessage, right: PromptMessage): number {
  const leftTimestamp = typeof left.timestamp_ms === "number" ? left.timestamp_ms : 0;
  const rightTimestamp = typeof right.timestamp_ms === "number" ? right.timestamp_ms : 0;
  return leftTimestamp - rightTimestamp;
}

function mergeableChatWindowEntries(ctx: FinalizedMsgContext) {
  return (ctx.ChannelStructuredContext ?? []).filter(
    (entry): entry is typeof entry & { payload: Record<string, unknown> } =>
      entry.type === "chat_window" &&
      entry.sessionTranscriptMode !== "preserve" &&
      Boolean(entry.payload) &&
      typeof entry.payload === "object" &&
      !Array.isArray(entry.payload),
  );
}

/**
 * A platform-selected recent window keeps its own rows, except rows the model
 * already answered as user turns of this session: the conversation (and a
 * native runtime thread fed by it) holds them, so quoting them again on every
 * later turn only duplicates context. Only completed answers cover the preceding
 * request. Changed platform text and requests with incomplete output stay eligible.
 */
async function omitAnsweredRecentHistory(params: {
  agentId: string;
  ctx: FinalizedMsgContext;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const history = params.ctx.InboundHistory ?? [];
  let candidates = 0;
  for (const entry of history) {
    candidates += entry.messageId ? 1 : 0;
  }
  if (candidates === 0) {
    return;
  }
  // Roughly one user row and one reply per answered turn; a shorter read only keeps rows.
  const turns = await readRecentUserAssistantTurnsForSession({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    limit: candidates * 2,
    includeMessageToolSourceReplies: true,
  });
  // A reply proves only the user row right before it; earlier rows in the same gap
  // (a failed turn, or collected extras) stay, since a duplicate beats lost context.
  const answered = new Map<string, string>();
  let replied = false;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === "assistant") {
      replied ||= turn.isCompletedAnswer === true;
      continue;
    }
    if (replied && turn.messageId && !answered.has(turn.messageId)) {
      answered.set(turn.messageId, turn.text);
    }
    replied = false;
  }
  if (answered.size > 0) {
    params.ctx.InboundHistory = history.filter(
      // Text equality cannot prove that historical attachments are unchanged.
      (entry) =>
        !entry.messageId ||
        Boolean(entry.media?.length) ||
        answered.get(entry.messageId) !== entry.body.trim(),
    );
  }
}

/** Merges active canonical transcript turns into the prepared channel history in place. */
export async function mergeSessionTranscriptContext(params: {
  agentId?: string;
  ctx: FinalizedMsgContext;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const options = params.ctx.SessionTranscriptContext;
  const limit = Math.max(0, Math.floor(options?.historyLimit ?? 0));
  if (
    limit === 0 ||
    isSessionBoundaryCommandText(params.ctx.CommandBody ?? params.ctx.RawBody, {
      botUsername: params.ctx.BotUsername,
    })
  ) {
    return;
  }
  // Routed channel turns provide agentId; direct callers may derive only an
  // explicitly scoped owner. Unscoped keys without routing context fail closed.
  const agentId = params.agentId?.trim() || parseAgentSessionKey(params.sessionKey)?.agentId;
  if (options?.historyKind === "recent") {
    if (agentId) {
      await omitAnsweredRecentHistory({ ...params, agentId });
    }
    return;
  }
  if (!agentId) {
    throw new Error("Session transcript context requires an agent owner.");
  }
  const windows = mergeableChatWindowEntries(params.ctx);
  const turns = await readRecentUserAssistantTextForSession({
    agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    limit,
    // A session-generated window must retain delivered close-outs alongside
    // their questions. Native channel windows already own their delivery history.
    ...(windows.length === 0 && options?.chatWindow === true
      ? {
          includeCronDirectDeliveryContext: true,
          includeMessageToolSourceReplies: true,
          ...(options.deliveryOnly ? { deliveryOnly: true } : {}),
        }
      : {}),
    ...((options?.beforeTimestampMs ?? params.ctx.Timestamp) !== undefined
      ? { beforeTimestampMs: options?.beforeTimestampMs ?? params.ctx.Timestamp }
      : {}),
    ...(options?.minTimestampMs !== undefined ? { minTimestampMs: options.minTimestampMs } : {}),
  });
  const labels = options?.senderLabels ?? { assistant: "Assistant", user: "User" };
  const transcript = turns.map((turn) => {
    const item: TranscriptMessage = {
      entry: {
        sender: `${labels[turn.role]}${turn.sourceChannel ? ` (${turn.sourceChannel})` : ""}`,
        body: turn.text,
      },
      role: turn.role,
    };
    if (turn.id) {
      item.transcriptId = turn.id;
      item.entry.messageId = `session:${turn.id}`;
    }
    if (turn.timestamp !== undefined) {
      item.entry.timestamp = turn.timestamp;
    }
    return item;
  });
  if (transcript.length === 0) {
    return;
  }
  if (windows.length === 0 && options?.chatWindow) {
    params.ctx.ChannelStructuredContext = [
      ...(params.ctx.ChannelStructuredContext ?? []),
      {
        label: "Conversation context",
        source: "session",
        type: "chat_window",
        payload: {
          order: "chronological",
          relation: "selected_for_current_message",
          messages: transcript.map(({ entry }) => historyMessage(entry)).slice(-limit),
        },
      },
    ];
    return;
  }
  if (windows.length === 0) {
    const existing = params.ctx.InboundHistory ?? [];
    const seen = new Set(existing.flatMap((entry) => messageKeys(historyMessage(entry))));
    const added = transcript.flatMap(({ entry }) => {
      const keys = messageKeys(historyMessage(entry));
      if (keys.some((key) => seen.has(key))) {
        return [];
      }
      keys.forEach((key) => seen.add(key));
      return [entry];
    });
    params.ctx.InboundHistory = [...existing, ...added]
      .toSorted((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
      .slice(-limit);
    return;
  }
  for (const window of windows) {
    const existing = Array.isArray(window.payload.messages)
      ? window.payload.messages.filter(
          (message): message is PromptMessage =>
            Boolean(message) && typeof message === "object" && !Array.isArray(message),
        )
      : [];
    const dedupeIds = window.sessionTranscriptDedupeMessageIds;
    const assistantTextKeys = window.sessionTranscriptAssistantTextDedupeKeys;
    const ids = new Set(filterStringEntries(dedupeIds));
    const assistantDedupeKeys = new Set(assistantTextKeys ?? []);
    const seen = new Set(existing.flatMap(messageKeys));
    const seenTranscript = new Set<string>();
    const added: PromptMessage[] = [];
    for (const item of transcript) {
      if (item.transcriptId && ids.has(item.transcriptId)) {
        continue;
      }
      const message = historyMessage(item.entry);
      const keys = messageKeys(message);
      const visibleAssistantKeys =
        item.role === "assistant"
          ? messageKeys({
              ...message,
              body: stripInlineDirectiveTagsForDelivery(item.entry.body).text,
            })
          : keys;
      if (
        keys.some((key) => seenTranscript.has(key)) ||
        (item.role === "assistant" &&
          visibleAssistantKeys.some((key) => assistantDedupeKeys.has(key))) ||
        (item.role === "user" && keys.some((key) => seen.has(key)))
      ) {
        continue;
      }
      keys.forEach((key) => seenTranscript.add(key));
      added.push(message);
    }
    let messages = [...added, ...existing].toSorted(compareMessages);
    if (!(messages.length <= limit)) {
      const pinned = messages.filter((message) => message.is_reply_target === true);
      const available = Math.max(0, limit - pinned.length);
      const recent =
        available === 0
          ? []
          : messages.filter((message) => message.is_reply_target !== true).slice(-available);
      messages = [...pinned.slice(-limit), ...recent].toSorted(compareMessages);
    }
    window.payload = { ...window.payload, messages };
    if (added.length > 0) {
      window.source = "session";
    }
  }
}
