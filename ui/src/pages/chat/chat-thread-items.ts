import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import { resolveToolUseId } from "../../../../src/chat/tool-content.js";
import type { ChatItem, ChatQueueItem, MessageGroup, ToolCard } from "../../lib/chat/chat-types.ts";
import { extractTextCached, readTranscriptMediaEntries } from "../../lib/chat/message-extract.ts";
import {
  canvasPreviewsMatch,
  readCanvasContentPreview,
  stripMessageDisplayMetadataText,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached, extractToolPreview } from "../../lib/chat/tool-cards.ts";
import { fnv1aUtf16 } from "../../lib/fnv1a.ts";
import { chatItemStartsUserTurn, safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

export function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
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
  return {
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
}

/** The caller selects normalized assistant groups; preserve their other content. */
function removeCanvasPreviewFromAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
): unknown {
  const raw = asRecord(message);
  if (!raw) {
    return message;
  }
  const content = Array.isArray(raw.content)
    ? raw.content
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  let changed = false;
  const nextContent: unknown[] = [];
  const structuredPreviews = content.flatMap((value) => readCanvasContentPreview(value) ?? []);
  for (const value of content) {
    const existing = readCanvasContentPreview(value);
    if (existing && canvasPreviewsMatch(existing, preview)) {
      changed = true;
      continue;
    }
    const block = asRecord(value);
    if (
      !block ||
      !["text", "input_text", "output_text"].includes(String(block.type)) ||
      typeof block.text !== "string"
    ) {
      nextContent.push(value);
      continue;
    }
    const extracted = extractCanvasShortcodes(block.text);
    if (!extracted.previews.some((candidate) => canvasPreviewsMatch(candidate, preview))) {
      nextContent.push(value);
      continue;
    }
    changed = true;
    nextContent.push({ ...block, text: extracted.text });
    for (const candidate of extracted.previews) {
      if (
        !canvasPreviewsMatch(candidate, preview) &&
        !structuredPreviews.some((structured) => canvasPreviewsMatch(candidate, structured))
      ) {
        nextContent.push({ type: "canvas", preview: candidate });
      }
    }
  }
  return changed ? { ...raw, content: nextContent } : message;
}

export function reconcileCanvasDisplayCopies(
  items: ChatItem[],
  grouped: Array<ChatItem | MessageGroup>,
  toolOwnedCanvasSources: ReadonlyMap<string, ChatMessagePreview>,
): ChatItem[] {
  // All history and live projections now have their actual positions. Resolve
  // display-copy ownership only here, using the same forwarded/projected/user
  // boundaries as grouping; earlier removal cannot restore a later turn's embed.
  let turnMessages: MessageGroup["messages"] = [];
  const replacements = new Map<unknown, unknown>();
  const duplicateCanvasMessages = new Set<unknown>();
  const finishCanvasTurn = () => {
    const owners: {
      message: unknown;
      source: ChatMessagePreview;
    }[] = [];
    for (const entry of turnMessages) {
      const source = toolOwnedCanvasSources.get(entry.key);
      if (!source) {
        continue;
      }
      if (owners.some((owner) => canvasPreviewsMatch(owner.source.preview, source.preview))) {
        duplicateCanvasMessages.add(entry.message);
      } else {
        owners.push({ message: entry.message, source });
      }
    }
    for (const entry of turnMessages) {
      if (toolOwnedCanvasSources.has(entry.key)) {
        continue;
      }
      for (const block of safeNormalizeMessage(entry.message)?.content ?? []) {
        if (block.type !== "canvas") {
          continue;
        }
        const owner = owners.find(({ source }) =>
          canvasPreviewsMatch(source.preview, block.preview),
        );
        if (!owner) {
          continue;
        }
        owner.source = { ...owner.source, preview: { ...owner.source.preview, ...block.preview } };
        replacements.set(
          entry.message,
          removeCanvasPreviewFromAssistantMessage(
            replacements.get(entry.message) ?? entry.message,
            block.preview,
          ),
        );
        replacements.set(
          owner.message,
          createCanvasAssistantMessage(owner.source, rawMessageTimestamp(owner.message)),
        );
      }
    }
    turnMessages = [];
  };
  for (const item of grouped) {
    if (item.kind !== "group") {
      if (chatItemStartsUserTurn(item) || item.kind === "divider") {
        finishCanvasTurn();
      }
      continue;
    }
    for (const entry of item.messages) {
      // A forwarded input can share a same-role group with earlier output.
      // Apply the canonical boundary predicate at the exact message position.
      if (chatItemStartsUserTurn({ ...item, messages: [entry] })) {
        finishCanvasTurn();
      }
      if (item.role === "assistant") {
        turnMessages.push(entry);
      }
    }
  }
  finishCanvasTurn();
  if (duplicateCanvasMessages.size === 0 && replacements.size === 0) {
    return items;
  }
  return items.flatMap<ChatItem>((item) => {
    if (item.kind !== "message") {
      return [item];
    }
    if (duplicateCanvasMessages.has(item.message)) {
      return [];
    }
    const message = replacements.get(item.message);
    return message === undefined
      ? [item]
      : hasRenderableNormalizedMessage(message)
        ? [{ ...item, message }]
        : [];
  });
}

export function messageMatchesSearchQuery(message: unknown, query: string): boolean {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query);
  return (
    !normalizedQuery ||
    normalizeLowercaseStringOrEmpty(extractTextCached(message)).includes(normalizedQuery)
  );
}

type ChatMessagePreview = {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
};

export function extractChatMessagePreview(toolMessage: unknown): ChatMessagePreview | null {
  if (!safeNormalizeMessage(toolMessage)) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage);
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: rawMessageTimestamp(toolMessage),
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName =
    typeof toolRecord.toolName === "string"
      ? toolRecord.toolName
      : typeof toolRecord.tool_name === "string"
        ? toolRecord.tool_name
        : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== "canvas") {
    return null;
  }
  return { preview, text: text ?? null, timestamp: rawMessageTimestamp(toolMessage) };
}

export function canvasPreviewBaseIdentity(
  message: unknown,
  source: ChatMessagePreview,
): string | null {
  const toolCallId = resolveMessageToolUseId(asRecord(message) ?? {});
  const previewId = source.preview.viewId
    ? `viewId:${source.preview.viewId}`
    : source.preview.url
      ? `url:${source.preview.url}`
      : null;
  return toolCallId && previewId ? JSON.stringify([toolCallId, previewId]) : null;
}

export function createCanvasAssistantMessage(
  source: ChatMessagePreview,
  timestamp = source.timestamp,
): unknown {
  return appendCanvasBlockToAssistantMessage(
    {
      role: "assistant",
      content: [],
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
  minimumIndex = 0,
  maximumIndex = items.length,
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

function resolveMessageToolUseId(message: Record<string, unknown>): string | undefined {
  for (const field of ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId"] as const) {
    const value = message[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveToolBlockId(
  block: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return resolveToolUseId(block) ?? resolveMessageToolUseId(message);
}

export function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.kind === "pending-send";
}

export function readPendingSendFailure(message: unknown): {
  error?: string;
  id: string;
  state: "failed" | "unconfirmed";
} | null {
  const metadata = asRecord(asRecord(message)?.["__openclaw"]);
  const state = metadata?.state;
  const id = metadata?.id;
  if (
    metadata?.kind !== "pending-send" ||
    (state !== "failed" && state !== "unconfirmed") ||
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

export function readChatThreadMessageIdentity(message: unknown) {
  const record = asRecord(message);
  const surfaceId =
    typeof record?.messageId === "string" && record.messageId.trim()
      ? record.messageId
      : record?.id;
  return readSessionMessageIdentity(message, { messageId: surfaceId });
}

/** Causal boundaries follow execution ownership, which can differ from the submit key. */
export function userTurnRunId(message: unknown): string | null {
  const identity = readChatThreadMessageIdentity(message);
  return identity?.role === "user" ? identity.runId : null;
}

export function persistedMessageEntryId(message: unknown): string | null {
  const id = readChatThreadMessageIdentity(message)?.id;
  return isPendingSendMessage(message) || id?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)
    ? null
    : (id ?? null);
}

function transcriptMessageSourceKey(message: unknown): string | null {
  // Send identity outranks transcript ids: the same submit is re-projected with
  // different id/seq metadata across the pending -> history handoff, and a key
  // change there remounts the bubble (visible flicker).
  const identity = readChatThreadMessageIdentity(message);
  if (identity?.sendId) {
    return `send:${identity.sendId}`;
  }
  if (identity?.isImported) {
    if (identity.externalSource) {
      return `import:${identity.externalSource}`;
    }
    return identity.sequence === null ? null : `import-seq:${identity.sequence}`;
  }
  if (identity?.id) {
    return `id:${identity.id}`;
  }
  return identity?.sequence == null ? null : `seq:${identity.sequence}`;
}

const messageProjectionDigests = new WeakMap<object, string>();

function messageProjectionDigest(message: unknown): string {
  if (message && typeof message === "object") {
    const cached = messageProjectionDigests.get(message);
    if (cached) {
      return cached;
    }
  }
  const record = asRecord(message);
  const source = [
    typeof record?.role === "string" ? record.role : "",
    typeof record?.toolCallId === "string" ? record.toolCallId : "",
    record ? extractTextCached(message) : "",
  ].join("\u0000");
  const digest = `p${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`;
  if (message && typeof message === "object") {
    messageProjectionDigests.set(message, digest);
  }
  return digest;
}

export function buildMessageItems<Message>(
  messages: Message[],
  resolveSourceKey: (message: Message) => string | null = transcriptMessageSourceKey,
): Array<Extract<ChatItem, { kind: "message" }> & { message: Message }> {
  const sourceKeys = messages.map(resolveSourceKey);
  const sourceCounts = new Map<string, number>();
  for (const sourceKey of sourceKeys) {
    if (sourceKey) {
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    }
  }
  const projectionOccurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const sourceKey = sourceKeys[index];
    const needsProjectionIdentity = sourceKey == null || (sourceCounts.get(sourceKey) ?? 0) > 1;
    const projectionKey = needsProjectionIdentity
      ? `${sourceKey ?? "legacy"}:projection:${messageProjectionDigest(message)}`
      : (sourceKey ?? "legacy");
    const occurrence = projectionOccurrences.get(projectionKey) ?? 0;
    projectionOccurrences.set(projectionKey, occurrence + 1);
    const record = asRecord(message);
    const callId = typeof record?.toolCallId === "string" ? record.toolCallId : "";
    const role = typeof record?.role === "string" ? record.role : "unknown";
    const transcriptKey = `${projectionKey}:${occurrence}`;
    return {
      kind: "message",
      key: callId ? `tool:${role}:${callId}:${transcriptKey}` : `msg:${transcriptKey}`,
      message,
    };
  });
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
    (role === "user" && readTranscriptMediaEntries(message).length),
  );
}

export function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

export function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  return buildLocalUserMessage({
    text: item.text,
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
  const latestTimestamp = items.reduce<number | null>((latest, item) => {
    const timestamp = chatItemTimestamp(item);
    if (timestamp == null) {
      return latest;
    }
    return latest == null || timestamp > latest ? timestamp : latest;
  }, null);
  return latestTimestamp != null && desiredTimestamp <= latestTimestamp
    ? latestTimestamp + 1
    : desiredTimestamp;
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

export function insertChatItemsByTimestamp(items: ChatItem[], inserts: ChatProjection[]): void {
  const timestampsByKey = new Map<string, number>();
  const placementsByKey = new Map<string, Pick<ChatProjection, "bounds" | "predecessorKey">>();
  for (const { item, bounds, predecessorKey } of inserts) {
    const timestamp = chatItemTimestamp(item);
    if (timestamp != null) {
      timestampsByKey.set(item.key, timestamp);
    }
    // Repeated logical keys share the last supplied fact for each field;
    // an unbounded projection must not erase an earlier causal constraint.
    const placement = placementsByKey.get(item.key) ?? {};
    if (bounds) {
      placement.bounds = bounds;
    }
    if (predecessorKey) {
      placement.predecessorKey = predecessorKey;
    }
    placementsByKey.set(item.key, placement);
  }
  // Sort inserts among themselves by timestamp, preserving the original index
  // order for ties and honoring predecessor relationships so a stream segment
  // stays before the tool card it introduced.
  const sortedInserts = inserts
    .map(({ item }, index) => {
      const rawTimestamp = chatItemTimestamp(item);
      const predecessorKey = placementsByKey.get(item.key)?.predecessorKey;
      const predecessorTimestamp = predecessorKey ? timestampsByKey.get(predecessorKey) : null;
      return {
        item,
        index,
        predecessorKey,
        effectiveTimestamp:
          rawTimestamp != null && predecessorTimestamp != null
            ? Math.max(rawTimestamp, predecessorTimestamp)
            : rawTimestamp,
      };
    })
    .toSorted((a, b) => {
      if (a.effectiveTimestamp == null && b.effectiveTimestamp == null) {
        return a.index - b.index;
      }
      if (a.effectiveTimestamp == null) {
        return 1;
      }
      if (b.effectiveTimestamp == null) {
        return -1;
      }
      if (a.effectiveTimestamp !== b.effectiveTimestamp) {
        return a.effectiveTimestamp - b.effectiveTimestamp;
      }
      if (a.predecessorKey === b.item.key) {
        return 1;
      }
      if (b.predecessorKey === a.item.key) {
        return -1;
      }
      return a.index - b.index;
    });

  for (const { item, effectiveTimestamp } of sortedInserts) {
    const { minimum, maximum } = insertionIndexesForBounds(
      items,
      placementsByKey.get(item.key)?.bounds,
    );
    if (effectiveTimestamp == null) {
      items.splice(maximum, 0, item);
      continue;
    }
    const insertionIndex = items.findIndex((existing, index) => {
      if (index < minimum || index >= maximum) {
        return false;
      }
      const existingTimestamp = chatItemTimestamp(existing);
      // Timestamped inserts render before stable items that lack a timestamp.
      if (existingTimestamp == null) {
        return true;
      }
      return existingTimestamp > effectiveTimestamp;
    });

    if (insertionIndex === -1) {
      items.splice(maximum, 0, item);
    } else {
      items.splice(insertionIndex, 0, item);
    }
  }
}
