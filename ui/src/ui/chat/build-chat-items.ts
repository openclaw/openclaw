import { extractCanvasShortcodes } from "../../../../src/chat/canvas-render.js";
import type { ChatItem, MessageGroup, ToolCard } from "../types/chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeMessage } from "./message-normalizer.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";
import { messageMatchesSearchQuery } from "./search-match.ts";
import { extractToolCards, extractToolPreview } from "./tool-cards.ts";

const CHAT_HISTORY_RENDER_LIMIT = 200;

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  showToolCalls: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};

function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContentRaw = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  const existingContent: unknown[] = [];
  for (const block of existingContentRaw) {
    let nextBlock = block;
    if (block && typeof block === "object") {
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        const strippedText = stripSingleMatchingCanvasShortcode(typed.text, preview);
        nextBlock =
          strippedText === typed.text ? block : Object.assign({}, typed, { text: strippedText });
        if (!strippedText.trim()) {
          continue;
        }
      }
    }
    existingContent.push(nextBlock);
  }
  let upgradedExisting = false;
  const upgradedContent = existingContent.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const typed = block as {
      type?: unknown;
      preview?: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    };
    if (typed.type !== "canvas" || !typed.preview || !canvasPreviewsMatch(typed.preview, preview)) {
      return block;
    }
    const mergedPreview = mergeCanvasPreview(typed.preview, preview);
    if (mergedPreview === typed.preview) {
      return block;
    }
    upgradedExisting = true;
    return { ...typed, preview: mergedPreview };
  });
  if (upgradedExisting) {
    return {
      ...raw,
      content: upgradedContent,
    };
  }
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
      canvasPreviewsMatch(
        typed.preview as Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
        preview,
      )
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

function canvasPreviewsMatch(
  a: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  b: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
): boolean {
  return Boolean(
    (a.viewId && b.viewId && a.viewId === b.viewId) || (a.url && b.url && a.url === b.url),
  );
}

function mergeCanvasPreview(
  existing: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  next: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
): Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }> {
  if (!canvasPreviewsMatch(existing, next)) {
    return existing;
  }
  const existingMcpApp = existing.mcpApp;
  const nextMcpApp = next.mcpApp;
  if (!nextMcpApp) {
    return existing;
  }
  const mergedMcpApp = {
    ...nextMcpApp,
    ...existingMcpApp,
    ...(existingMcpApp?.toolInput === undefined && nextMcpApp.toolInput !== undefined
      ? { toolInput: nextMcpApp.toolInput }
      : {}),
    ...(existingMcpApp?.toolResult === undefined && nextMcpApp.toolResult !== undefined
      ? { toolResult: nextMcpApp.toolResult }
      : {}),
    ...(existingMcpApp?.sessionKey === undefined && nextMcpApp.sessionKey !== undefined
      ? { sessionKey: nextMcpApp.sessionKey }
      : {}),
  };
  return {
    ...next,
    ...existing,
    mcpApp: mergedMcpApp,
  };
}

function stripSingleMatchingCanvasShortcode(
  text: string,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
): string {
  const extracted = extractCanvasShortcodes(text);
  if (extracted.previews.length !== 1) {
    return text;
  }
  return canvasPreviewsMatch(extracted.previews[0], preview) ? extracted.text : text;
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = normalizeMessage(toolMessage);
  const cards = extractToolCards(toolMessage, "preview");
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
  if (Array.isArray(toolRecord.content)) {
    for (let index = toolRecord.content.length - 1; index >= 0; index--) {
      const item = toolRecord.content[index];
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        continue;
      }
      const preview = extractToolPreview(text, toolName);
      if (preview?.kind === "canvas") {
        return { preview, text, timestamp: normalized.timestamp ?? null };
      }
    }
  }
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
        timestamp: normalizeMessage(item.message).timestamp ?? null,
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
    return nextDelta <= previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

function findAssistantMessageIndexWithCanvasPreview(
  items: ChatItem[],
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  toolTimestamp: number | null,
): number | null {
  let best: { index: number; delta: number } | null = null;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || item.kind !== "message") {
      continue;
    }
    const normalized = normalizeMessage(item.message);
    if (normalized.role.toLowerCase() !== "assistant") {
      continue;
    }
    const hasPreview = normalized.content.some(
      (block) =>
        block.type === "canvas" &&
        block.preview.kind === "canvas" &&
        canvasPreviewsMatch(block.preview, preview),
    );
    if (!hasPreview) {
      continue;
    }
    const delta =
      toolTimestamp != null && normalized.timestamp != null
        ? Math.abs(normalized.timestamp - toolTimestamp)
        : 0;
    if (!best || delta < best.delta) {
      best = { index, delta };
    }
  }
  return best?.index ?? null;
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
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const liftedCanvasSources: Array<{
    preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    text: string | null;
    timestamp: number | null;
  }> = [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (normalized.role.toLowerCase() === "toolresult") {
      const lifted = extractChatMessagePreview(msg);
      if (lifted) {
        liftedCanvasSources.push(lifted);
      }
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  liftedCanvasSources.push(
    ...(tools
      .map((tool) => extractChatMessagePreview(tool))
      .filter((entry) => Boolean(entry)) as Array<{
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      text: string | null;
      timestamp: number | null;
    }>),
  );
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex =
      findAssistantMessageIndexWithCanvasPreview(
        items,
        liftedCanvasSource.preview,
        liftedCanvasSource.timestamp,
      ) ?? findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
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
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length && segments[i].text.trim().length > 0) {
      items.push({
        kind: "stream",
        key: `stream-seg:${props.sessionKey}:${i}`,
        text: segments[i].text,
        startedAt: segments[i].ts,
      });
    }
    if (i < tools.length && props.showToolCalls) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
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
