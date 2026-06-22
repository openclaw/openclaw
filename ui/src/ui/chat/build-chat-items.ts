// Control UI chat module implements build chat items behavior.
import type { ChatItem, MessageGroup, NormalizedMessage, ToolCard } from "../types/chat-types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";
import { CHAT_HISTORY_RENDER_CHAR_BUDGET, CHAT_HISTORY_RENDER_LIMIT } from "./history-limits.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeMessage, stripMessageDisplayMetadataText } from "./message-normalizer.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";
import { messageMatchesSearchQuery } from "./search-match.ts";
import {
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "./stream-text.ts";
import { extractToolCardsCached, extractToolPreview } from "./tool-cards.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  historyRenderLimit?: number;
};

function appendCanvasBlockToAssistantMessage(
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
  const alreadyHasArtifact = existingContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as {
      type?: unknown;
      preview?: { kind?: unknown; viewId?: unknown; url?: unknown };
    };
    return (
      typed.type === "canvas" &&
      typed.preview?.kind === "canvas" &&
      ((preview.viewId && typed.preview.viewId === preview.viewId) ||
        (preview.url && typed.preview.url === preview.url))
    );
  });
  if (alreadyHasArtifact) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = safeNormalizeMessage(toolMessage);
  if (!normalized) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: normalized.timestamp ?? null,
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
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  const assistantEntries = items
    .map((item, index) => {
      if (item.kind !== "message") {
        return null;
      }
      const message = item.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
      if (role !== "assistant") {
        return null;
      }
      return {
        index,
        timestamp: safeNormalizeMessage(item.message)?.timestamp ?? null,
      };
    })
    .filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) {
    return null;
  }
  if (toolTimestamp == null) {
    return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  }
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) {
      continue;
    }
    if (entry.timestamp <= toolTimestamp) {
      previous = { index: entry.index, timestamp: entry.timestamp };
      continue;
    }
    next = { index: entry.index, timestamp: entry.timestamp };
    break;
  }
  if (previous && next) {
    const previousDelta = toolTimestamp - previous.timestamp;
    const nextDelta = next.timestamp - toolTimestamp;
    return nextDelta < previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel =
      role.toLowerCase() === "user" || role.toLowerCase() === "assistant"
        ? (normalized.senderLabel ?? null)
        : null;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role.toLowerCase() === "user" || role.toLowerCase() === "assistant";

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (shouldSplitBySender && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.kind === "pending-send";
}

function sourceMessageId(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  const openclawId = asRecord(record["__openclaw"])?.id;
  if (typeof openclawId === "string" && openclawId.trim()) {
    return openclawId.trim();
  }
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  if (messageId) {
    return messageId;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return id || null;
}

function collapseDuplicateSourceKey(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== "assistant") {
    return null;
  }
  const id = sourceMessageId(message);
  return id ? `${role}:${id}` : null;
}

function prefersNativeChatSurface(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  return (role === "user" || role === "assistant") && !(normalized.senderLabel ?? "").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  const label = senderLabel.trim();
  if (!label) {
    return text;
  }
  return text.replace(new RegExp(`^${escapeRegExp(label)}(?::|：|-|—)?[ \\t]+`), "");
}

function sourceDuplicateDisplayParts(message: unknown): {
  role: string;
  senderLabel: string;
  text: string;
} | null {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== "assistant") {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n");
  if (!text.trim()) {
    return null;
  }
  return {
    role,
    senderLabel: (normalized.senderLabel ?? "").trim(),
    text,
  };
}

function isSameSourceRelayNativeDuplicate(previousMessage: unknown, nextMessage: unknown): boolean {
  const previous = sourceDuplicateDisplayParts(previousMessage);
  const next = sourceDuplicateDisplayParts(nextMessage);
  if (!previous || !next || previous.role !== next.role) {
    return false;
  }
  if (Boolean(previous.senderLabel) === Boolean(next.senderLabel)) {
    return false;
  }
  const labeled = previous.senderLabel ? previous : next;
  const native = previous.senderLabel ? next : previous;
  return (
    labeled.text === native.text ||
    stripSenderLabelPrefix(labeled.text, labeled.senderLabel) === native.text
  );
}

function assistantGroupHasReplyText(group: MessageGroup): boolean {
  // A real reply is assistant text; a tool-only assistant group does not count.
  return group.messages.some(({ message }) => Boolean(extractTextCached(message)?.trim()));
}

// Stamp each tool group with whether its turn ended in a successful assistant
// reply. Codex marks any non-zero exec exit as failed, so a benign internal tool
// failure (e.g. a no-match search) must not render as a primary error banner
// once a clean reply exists. Backward pass: a user group ends the turn
// downstream; an assistant reply marks success for earlier tool groups in the
// same turn. turnSucceeded stays undefined for terminal or in-progress failures,
// preserving the existing error banner.
function annotateToolTurnOutcome(
  items: Array<ChatItem | MessageGroup>,
): Array<ChatItem | MessageGroup> {
  let sawAssistantReply = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== "group") {
      continue;
    }
    const role = item.role.toLowerCase();
    if (role === "user") {
      sawAssistantReply = false;
    } else if (role === "assistant") {
      if (assistantGroupHasReplyText(item)) {
        sawAssistantReply = true;
      }
    } else if (role === "tool") {
      item.turnSucceeded = sawAssistantReply;
    }
  }
  return items;
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (!role || role === "tool") {
    return null;
  }
  if (normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n").trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel =
    role === "user" || role === "assistant" ? (normalized.senderLabel ?? "").trim() : "";
  return `${role}:${senderLabel}:${text}`;
}

function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;
  let previousSourceKey: string | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      previousSourceKey = null;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const sourceKey = collapseDuplicateSourceKey(item.message);
    const previous = collapsed[collapsed.length - 1];
    if (
      sourceKey &&
      previousSourceKey === sourceKey &&
      previous?.kind === "message" &&
      isSameSourceRelayNativeDuplicate(previous.message, item.message)
    ) {
      if (!prefersNativeChatSurface(previous.message) && prefersNativeChatSurface(item.message)) {
        collapsed[collapsed.length - 1] = item;
        previousSignature = signature;
      }
      continue;
    }
    if (
      signature &&
      previousSignature === signature &&
      previous?.kind === "message" &&
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey)
    ) {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
    previousSourceKey = sourceKey;
  }

  return collapsed;
}

function hasRenderableNormalizedMessage(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const hasVisibleSenderLabel = role === "assistant" && Boolean(normalized.senderLabel?.trim());
  return normalized.content.length > 0 || Boolean(normalized.replyTarget) || hasVisibleSenderLabel;
}

function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  if (typeof item.sendSubmittedAtMs !== "number" || item.sendState === "failed") {
    return false;
  }
  return (
    item.sendState === "waiting-model" ||
    item.sendState === "sending" ||
    item.sendState === "waiting-reconnect"
  );
}

function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  const content = buildUserChatMessageContentBlocks(item.text, item.attachments);
  if (content.length === 0) {
    return null;
  }
  return {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: {
      kind: "pending-send",
      id: item.id,
      state: item.sendState,
    },
  };
}

function rawMessageTimestamp(message: unknown): number | null {
  const timestamp = asRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case "message":
      return item.key === "chat:history:notice"
        ? Number.NEGATIVE_INFINITY
        : rawMessageTimestamp(item.message);
    case "divider":
      return item.timestamp;
    case "stream":
      return item.startedAt;
    case "reading-indicator":
      return null;
  }
  return null;
}

function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
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

function sortChatItemsByVisibleTime(items: ChatItem[]): ChatItem[] {
  return items
    .map((item, index) => ({ item, index, timestamp: chatItemTimestamp(item) }))
    .toSorted((a, b) => {
      if (a.timestamp == null && b.timestamp == null) {
        return a.index - b.index;
      }
      if (a.timestamp == null) {
        return 1;
      }
      if (b.timestamp == null) {
        return -1;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

type RawContentEstimateState = {
  visited: WeakSet<object>;
  nodes: number;
};

const RAW_CONTENT_ESTIMATE_MAX_DEPTH = 8;
const RAW_CONTENT_ESTIMATE_MAX_NODES = 400;

function addCapped(total: number, amount: number, limit: number): number {
  return Math.min(limit, total + Math.max(0, amount));
}

function estimateRawContentChars(
  value: unknown,
  limit: number,
  state: RawContentEstimateState,
  depth = 0,
): number {
  if (limit <= 0) {
    return 0;
  }
  if (typeof value === "string") {
    return Math.min(value.length, limit);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (depth >= RAW_CONTENT_ESTIMATE_MAX_DEPTH || state.nodes >= RAW_CONTENT_ESTIMATE_MAX_NODES) {
    return 0;
  }
  if (state.visited.has(value)) {
    return 0;
  }
  state.visited.add(value);
  state.nodes += 1;

  if (Array.isArray(value)) {
    let chars = 0;
    for (const item of value) {
      chars = addCapped(
        chars,
        estimateRawContentChars(item, limit - chars, state, depth + 1),
        limit,
      );
      if (chars >= limit) {
        break;
      }
    }
    return chars;
  }

  const record = value as Record<string, unknown>;
  let chars = 0;
  for (const key of ["text", "content", "args", "arguments", "input"] as const) {
    chars = addCapped(
      chars,
      estimateRawContentChars(record[key], limit - chars, state, depth + 1),
      limit,
    );
    if (chars >= limit) {
      break;
    }
  }
  return chars;
}

function estimateMessageRenderChars(message: unknown, limit: number): number {
  const record = asRecord(message);
  if (!record) {
    return 1;
  }
  const state: RawContentEstimateState = { visited: new WeakSet<object>(), nodes: 0 };
  let chars = 0;
  for (const key of ["content", "text", "args", "arguments", "input"] as const) {
    chars = addCapped(chars, estimateRawContentChars(record[key], limit - chars, state), limit);
    if (chars >= limit) {
      break;
    }
  }
  return Math.max(chars, 1);
}

function isHiddenToolMessage(message: unknown, showToolCalls: boolean): boolean {
  if (showToolCalls) {
    return false;
  }
  return safeNormalizeMessage(message)?.role.toLowerCase() === "toolresult";
}

function countVisibleHistoryMessages(messages: unknown[], showToolCalls: boolean): number {
  let count = 0;
  for (const message of messages) {
    if (!isHiddenToolMessage(message, showToolCalls)) {
      count += 1;
    }
  }
  return count;
}

function resolveHistoryRenderLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return CHAT_HISTORY_RENDER_LIMIT;
  }
  return Math.max(1, Math.min(CHAT_HISTORY_RENDER_LIMIT, Math.floor(limit)));
}

function resolveHistoryStartIndex(
  messages: unknown[],
  showToolCalls: boolean,
  renderLimit: number,
): number {
  let visibleCount = 0;
  let renderChars = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isHiddenToolMessage(message, showToolCalls)) {
      continue;
    }
    if (visibleCount >= renderLimit) {
      break;
    }
    const remainingBudget = Math.max(1, CHAT_HISTORY_RENDER_CHAR_BUDGET - renderChars + 1);
    const messageChars = estimateMessageRenderChars(message, remainingBudget);
    if (visibleCount > 0 && renderChars + messageChars > CHAT_HISTORY_RENDER_CHAR_BUDGET) {
      break;
    }
    renderChars += messageChars;
    visibleCount += 1;
    startIndex = index;
  }
  return startIndex;
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const historyRenderLimit = resolveHistoryRenderLimit(props.historyRenderLimit);
  const history = (Array.isArray(props.messages) ? props.messages : []).filter(
    (message) => !isAssistantHeartbeatAckForDisplay(message),
  );
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const liftedCanvasSources = tools
    .map((tool) => extractChatMessagePreview(tool))
    .filter((entry) => Boolean(entry)) as Array<{
    preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    text: string | null;
    timestamp: number | null;
  }>;
  const historyStart = resolveHistoryStartIndex(history, props.showToolCalls, historyRenderLimit);
  const hiddenHistoryCount = countVisibleHistoryMessages(
    history.slice(0, historyStart),
    props.showToolCalls,
  );
  const visibleHistoryCount = countVisibleHistoryMessages(
    history.slice(historyStart),
    props.showToolCalls,
  );
  if (hiddenHistoryCount > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${visibleHistoryCount} messages (${hiddenHistoryCount} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw["__openclaw"] as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compacted history",
        description:
          "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
        action: {
          kind: "session-checkpoints",
          label: "Open checkpoints",
        },
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== "assistant") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  const queuedSends = Array.isArray(props.queue) ? props.queue : [];
  for (const queued of queuedSends) {
    if (!shouldRenderQueuedSendInThread(queued)) {
      continue;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      continue;
    }
    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      continue;
    }
    items.push({
      kind: "message",
      key: `pending-send:${queued.id}`,
      message,
    });
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== "message") {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments ?? [];
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter((segment) => !streamSegmentHasItemId(segment));
  const maxLen = Math.max(indexedSegments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  for (let i = 0; i < maxLen; i++) {
    if (i < indexedSegments.length) {
      const segment = indexedSegments[i];
      const text = sanitizeStreamText(segment.text);
      const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
      const visibleText = usesAccumulatedText
        ? trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText)
        : text;
      if (usesAccumulatedText && text.length > 0) {
        previousAccumulatedStreamText = text;
      }
      if (visibleText.length > 0) {
        items.push({
          kind: "stream",
          key: `stream-seg:${props.sessionKey}:${i}`,
          text: visibleText,
          startedAt: segment.ts,
          isStreaming: false,
        });
      }
    }
    if (i < tools.length && props.showToolCalls) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      items.push({
        kind: "stream",
        key: `stream-seg:${props.sessionKey}:${segment.itemId}`,
        text,
        startedAt: segment.ts,
        isStreaming: false,
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    const startedAt = timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now());
    if (visibleText.length > 0) {
      if (!stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
        items.push({
          kind: "stream",
          key,
          text: visibleText,
          startedAt,
          isStreaming: true,
        });
      }
    } else if (props.stream.trim().length === 0) {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return annotateToolTurnOutcome(
    groupMessages(collapseSequentialDuplicateMessages(sortChatItemsByVisibleTime(items))),
  );
}

function messageKey(message: unknown, index: number): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    const id = typeof m.id === "string" ? m.id : "";
    if (id) {
      return `tool:${role}:${toolCallId}:${id}`;
    }
    const messageId = typeof m.messageId === "string" ? m.messageId : "";
    if (messageId) {
      return `tool:${role}:${toolCallId}:${messageId}`;
    }
    const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
    if (timestamp != null) {
      return `tool:${role}:${toolCallId}:${timestamp}:${index}`;
    }
    return `tool:${role}:${toolCallId}:${index}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
