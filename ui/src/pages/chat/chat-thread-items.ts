import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { resolveToolUseId } from "../../../../src/chat/tool-content.js";
import { messageSubagentCompletions } from "../../../../src/shared/subagent-completion.js";
import { markdownVisibleText } from "../../components/markdown-visible-text.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { prepareChatMessageRender } from "../../lib/chat/message-display.ts";
import { extractTextCached, readTranscriptMediaEntries } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  readCanvasContentPreview,
  normalizeRoleForGrouping,
  normalizeMessage,
} from "../../lib/chat/message-normalizer.ts";
import { hasVisiblePreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import {
  extractToolCardsCached,
  extractToolPreview,
  type CanvasToolPreview,
} from "../../lib/chat/tool-cards.ts";
import { stripThinkingTags } from "../../lib/strip-thinking-tags.ts";
import { phraseQueryPattern } from "../../lib/text-match.ts";
import {
  messageRecoveryKey,
  resolveFullMessageRecovery,
  type ChatMessageRecovery,
} from "./chat-message-recovery.ts";
import { subagentCompletionText } from "./chat-spawned-subagent.ts";
import { chatItemStartsUserTurn, safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { copyLiveTerminalIdentity } from "./terminal-message-identity.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

export {
  buildMessageItems,
  isPendingSendMessage,
  persistedMessageEntryId,
  transcriptMessageSourceKey,
} from "./chat-thread-item-identity.ts";

export function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: CanvasToolPreview,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  // A shortcode carries identity, not the tool's sandbox or App descriptor.
  // Only an existing structured block can replace the canonical projection.
  if (
    existingContent.some((block) => {
      const existing = readCanvasContentPreview(block);
      return existing && canvasPreviewsMatch(existing, preview);
    })
  ) {
    return message;
  }
  const projection = {
    ...raw,
    content: [
      ...existingContent,
      {
        type: "canvas",
        preview,
        ...(rawText ? { rawText } : {}),
      },
    ],
  };
  copyLiveTerminalIdentity(message, projection);
  return projection;
}

export function createChatSearchMatcher(
  query: string,
  recovery?: ChatMessageRecovery,
): (message: unknown) => boolean {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query).normalize("NFC");
  if (!normalizedQuery) {
    return () => true;
  }
  const phrase = phraseQueryPattern(query);
  const sourceMatches = (markdown: string | null) =>
    normalizeLowercaseStringOrEmpty(markdown).normalize("NFC").includes(normalizedQuery);
  return (message) => {
    const completions = messageSubagentCompletions(message);
    if (
      completions.length &&
      (sourceMatches(completions.map((entry) => entry.label ?? "").join("\n")) ||
        sourceMatches(subagentCompletionText(completions)))
    ) {
      return true;
    }
    const role = recovery ? normalizeRoleForGrouping(normalizeMessage(message).role) : "";
    const expansion = recovery
      ? resolveFullMessageRecovery(message, role, {
          displayFacts: recovery.displayFacts,
          canFetchFullMessage: recovery.canFetchFullMessage ?? true,
          getAssistantMessageExpansion: (id) =>
            recovery.messages.get(messageRecoveryKey(recovery.agentId, id)),
        })?.state
      : undefined;
    // Keep source syntax and link destinations searchable, then compare the same
    // display preparation used by message rendering.
    if (expansion?.status === "loaded") {
      const markdown =
        role === "assistant" ? stripThinkingTags(expansion.markdown) : expansion.markdown;
      const recovered = expansion.message ? prepareChatMessageRender(expansion.message) : undefined;
      return (
        sourceMatches(markdown) ||
        (phrase !== null &&
          markdownVisibleText(expansion, markdown, {
            mode: "document",
            humanMentions:
              recovered?.displayMarkdown === markdown ? recovered.humanMentions : undefined,
            assistantTranscriptRoleHeaders: role === "assistant",
          }).search(phrase) >= 0)
      );
    }
    if (sourceMatches(extractTextCached(message))) {
      return true;
    }
    const prepared = prepareChatMessageRender(message);
    return (
      phrase !== null &&
      markdownVisibleText(message, prepared.displayMarkdown, {
        humanMentions: prepared.humanMentions,
        assistantTranscriptRoleHeaders: prepared.normalizedMessage.role === "assistant",
      }).search(phrase) >= 0
    );
  };
}

type ChatMessagePreview = NonNullable<ReturnType<typeof readChatMessagePreview>>;

const chatMessagePreviews = new WeakMap<object, ChatMessagePreview | null>();

export function extractChatMessagePreview(toolMessage: unknown): ChatMessagePreview | null {
  const message = asRecord(toolMessage);
  if (!message) {
    return null;
  }
  const cached = chatMessagePreviews.get(message);
  if (cached !== undefined) {
    return cached;
  }
  // A negative result also belongs to this immutable message snapshot.
  const preview = readChatMessagePreview(message);
  chatMessagePreviews.set(message, preview);
  return preview;
}

function readChatMessagePreview(toolMessage: Record<string, unknown>) {
  // Recorded Canvas references are text, not views created by this OpenClaw session.
  if (asRecord(toolMessage["__openclaw"])?.catalogSource === true) {
    return null;
  }
  if (!safeNormalizeMessage(toolMessage)) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage);
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        runId: card.runId,
        parentToolCallId: card.parentToolCallId,
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: rawMessageTimestamp(toolMessage),
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const preview = extractToolPreview(text);
  if (preview?.kind !== "canvas") {
    return null;
  }
  return { preview, text: text ?? null, timestamp: rawMessageTimestamp(toolMessage) };
}

export function canvasPreviewBaseIdentity(
  message: unknown,
  source: ChatMessagePreview,
): string | null {
  // A nested result and its wrapper are receipts for the same invocation.
  const toolCallId = source.parentToolCallId ?? resolveMessageToolUseId(asRecord(message) ?? {});
  const previewId = source.preview.viewId
    ? `viewId:${source.preview.viewId}`
    : source.preview.url
      ? `url:${source.preview.url}`
      : null;
  return toolCallId && previewId
    ? JSON.stringify([source.runId ?? null, toolCallId, previewId])
    : null;
}

export function createCanvasAssistantMessage(
  source: ChatMessagePreview,
  timestamp: number | null,
): unknown {
  return appendCanvasBlockToAssistantMessage(
    {
      role: "assistant",
      content: [],
      ...(source.runId ? { runId: source.runId } : {}),
      ...(timestamp != null ? { timestamp } : {}),
    },
    source.preview,
    source.text,
  );
}

export function transcriptPositionTimestamp(
  messages: unknown[],
  sourceIndex: number,
): number | null {
  let previous: number | null = null;
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    previous = rawMessageTimestamp(messages[index]);
    if (previous != null) {
      break;
    }
  }
  let next: number | null = null;
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    next = rawMessageTimestamp(messages[index]);
    if (next != null) {
      break;
    }
  }
  if (previous != null && next != null) {
    return previous < next ? Math.min(previous + 1, next) : next;
  }
  if (previous != null) {
    return previous + 1;
  }
  return next;
}

export function findNearestAssistantMessage(
  items: ChatItem[],
  toolTimestamp: number | null,
  minimumIndex: number,
  maximumIndex: number,
) {
  let currentTurnStart = minimumIndex;
  let currentTurnEnd = maximumIndex;
  for (let index = minimumIndex; index < maximumIndex; index += 1) {
    const item = items[index];
    if (!item || !chatItemStartsUserTurn(item)) {
      continue;
    }
    const boundaryTimestamp =
      item.kind === "notice"
        ? item.timestamp
        : item.kind === "message"
          ? (safeNormalizeMessage(item.message)?.timestamp ?? null)
          : null;
    if (toolTimestamp != null && boundaryTimestamp != null && boundaryTimestamp > toolTimestamp) {
      currentTurnEnd = index;
      break;
    }
    currentTurnStart = index + 1;
  }
  type Anchor = { index: number; item: Extract<ChatItem, { kind: "message" }> };
  let last: Anchor | null = null;
  let previous: { anchor: Anchor; timestamp: number } | null = null;
  // Keep stable traversal order: last preceding / first following assistant,
  // not a timestamp sort that could cross an existing reply.
  for (let index = currentTurnStart; index < currentTurnEnd; index++) {
    const item = items[index];
    if (item?.kind !== "message") {
      continue;
    }
    const message = asRecord(item.message);
    if (typeof message?.role !== "string" || message.role.toLowerCase() !== "assistant") {
      continue;
    }
    last = { index, item };
    const timestamp = safeNormalizeMessage(item.message)?.timestamp;
    if (toolTimestamp == null || timestamp == null) {
      continue;
    }
    if (timestamp <= toolTimestamp) {
      previous = { anchor: last, timestamp };
      continue;
    }
    return previous && toolTimestamp - previous.timestamp <= timestamp - toolTimestamp
      ? previous.anchor
      : last;
  }
  return previous?.anchor ?? last;
}

export function findCanvasInsertionIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
  minimumIndex: number,
  maximumIndex: number,
): number {
  if (toolTimestamp == null) {
    return maximumIndex;
  }
  for (let index = minimumIndex; index < maximumIndex; index += 1) {
    const item = items[index];
    if (item?.kind !== "message") {
      continue;
    }
    const normalized = safeNormalizeMessage(item.message);
    if (
      normalized &&
      normalizeRoleForGrouping(normalized.role).toLowerCase() === "user" &&
      normalized.timestamp != null &&
      normalized.timestamp > toolTimestamp
    ) {
      return index;
    }
  }
  return maximumIndex;
}

function resolveMessageToolUseId(message: Record<string, unknown>): string | undefined {
  return resolveToolUseId({ ...message, id: undefined });
}

export function resolveToolBlockId(
  block: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return resolveToolUseId(block) ?? resolveMessageToolUseId(message);
}

export function readPendingSendStatus(message: unknown): {
  error?: string;
  id: string;
  state:
    | "failed"
    | "held"
    | "waiting-reconnect"
    | "waiting-model"
    | "waiting-idle"
    | "submitting"
    | "sending";
} | null {
  const metadata = asRecord(asRecord(message)?.["__openclaw"]);
  const state = metadata?.state;
  const id = metadata?.id;
  if (
    metadata?.kind !== "pending-send" ||
    (state !== "failed" &&
      state !== "held" &&
      state !== "waiting-reconnect" &&
      state !== "waiting-model" &&
      state !== "waiting-idle" &&
      state !== "submitting" &&
      state !== "sending") ||
    typeof id !== "string"
  ) {
    return null;
  }
  return {
    id,
    state,
    ...(typeof metadata.error === "string" ? { error: metadata.error } : {}),
  };
}

export function hasRenderableNormalizedMessage(
  message: unknown,
  normalized = safeNormalizeMessage(message),
): boolean {
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const label = role === "assistant" && normalized.senderLabel?.trim();
  return Boolean(
    role === "tool" ||
    normalized.content.length ||
    normalized.replyTarget ||
    label ||
    hasVisiblePreparedActivity(message) ||
    readTranscriptMediaEntries(message).length,
  );
}

export function sanitizeStreamText(text: string): string {
  const stripped = stripInboundMetadata(text);
  return stripped.trim().length > 0 ? stripped : "";
}

export function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  return buildLocalUserMessage({
    text: item.text,
    workContext: item.workContext,
    appContext: item.appContext,
    mentions: item.mentions,
    attachments: item.attachments,
    createdAt: item.createdAt,
    runId: item.sendRunId ?? item.pendingRunId,
    replyToId: item.replyToId,
    sender: item.sender,
    pending: {
      id: item.id,
      state: item.sendState,
      error: item.sendError,
    },
  });
}

export function rawMessageTimestamp(message: unknown): number | null {
  return asFiniteNumber(asRecord(message)?.timestamp) ?? null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case "message":
      return rawMessageTimestamp(item.message);
    case "divider":
    case "compaction":
    case "notice":
      return item.timestamp;
    case "stream":
    case "question":
      return item.startedAt;
    case "reading-indicator":
      return null;
  }
  return null;
}

export function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
  let next = desiredTimestamp;
  for (const item of items) {
    const time = chatItemTimestamp(item);
    if (time != null && time >= desiredTimestamp) {
      next = Math.max(next, time + 1);
    }
  }
  return next;
}

// Insert live tool/stream items into an already-ordered list of stable chat rows
// (history, queued sends, canvas previews, etc.) by visible timestamp. Stable
// rows keep their relative order; only tool cards and stream segments are
// repositioned. This avoids reordering optimistic user bubbles or final
// assistant replies when their timestamps come from different clocks (#112943).
export type TurnInsertionBounds = { afterKey?: string; beforeKey?: string };

export type ChatProjection<Item extends ChatItem = ChatItem> = {
  item: Item;
  bounds?: TurnInsertionBounds;
  predecessorKey?: string;
};

export function insertionIndexesForBounds(
  items: ChatItem[],
  bounds: TurnInsertionBounds | undefined,
): { minimum: number; maximum: number } {
  const afterIndex = bounds?.afterKey
    ? items.findIndex((item) => item.key === bounds.afterKey)
    : -1;
  const beforeIndex = bounds?.beforeKey
    ? items.findIndex((item) => item.key === bounds.beforeKey)
    : -1;
  return {
    minimum: afterIndex + 1,
    maximum: beforeIndex >= 0 ? beforeIndex : items.length,
  };
}

export function appendActiveRunItem(
  items: ChatItem[],
  bounds: TurnInsertionBounds | undefined,
  item: Extract<ChatItem, { kind: "stream" | "reading-indicator" }>,
): void {
  // Queued custody is a ceiling for the whole live response, not just its text.
  // Moving its working indicator past that ceiling splits and remeasures the run.
  items.splice(insertionIndexesForBounds(items, bounds).maximum, 0, item);
}

export function insertChatItemsByTimestamp(items: ChatItem[], inserts: ChatProjection[]): void {
  // Repeated logical keys share the last supplied fact for each field. Keep each
  // occurrence's own time, but never erase another occurrence's causal constraint.
  type Placement = Pick<ChatProjection, "bounds" | "predecessorKey"> & { timestamp?: number };
  const placements = new Map<string, Placement>();
  const ordered = inserts.map(({ item, bounds, predecessorKey }) => {
    const placement = placements.get(item.key) ?? {};
    const timestamp = chatItemTimestamp(item);
    if (timestamp != null) {
      placement.timestamp = timestamp;
    }
    if (bounds) {
      placement.bounds = bounds;
    }
    if (predecessorKey) {
      placement.predecessorKey = predecessorKey;
    }
    placements.set(item.key, placement);
    return { item, placement, timestamp };
  });
  for (const entry of ordered) {
    const key = entry.placement.predecessorKey;
    const predecessor = key ? placements.get(key)?.timestamp : undefined;
    if (entry.timestamp != null && predecessor != null) {
      entry.timestamp = Math.max(entry.timestamp, predecessor);
    }
  }
  // Array.sort is stable: only exact ties linked by a witnessed predecessor move.
  ordered.sort((a, b) => {
    if (a.timestamp == null || b.timestamp == null) {
      return Number(a.timestamp == null) - Number(b.timestamp == null);
    }
    return (
      a.timestamp - b.timestamp ||
      (a.placement.predecessorKey === b.item.key
        ? 1
        : b.placement.predecessorKey === a.item.key
          ? -1
          : 0)
    );
  });
  for (const { item, placement, timestamp } of ordered) {
    const { minimum, maximum } = insertionIndexesForBounds(items, placement.bounds);
    let index = maximum;
    if (timestamp != null) {
      for (let i = minimum; i < maximum; i++) {
        const existing = items[i];
        const existingTime = existing && chatItemTimestamp(existing);
        if (existingTime == null || existingTime > timestamp) {
          index = i;
          break;
        }
      }
    }
    items.splice(index, 0, item);
  }
}
