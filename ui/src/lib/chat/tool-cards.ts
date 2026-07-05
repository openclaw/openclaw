// Control UI chat domain owns pure tool-card extraction rules.
import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import type { ToolCard } from "./chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.messageId === "string" && message.messageId.trim()) {
    return message.messageId;
  }
  const openClawMeta = message["__openclaw"];
  const transcriptMeta =
    openClawMeta && typeof openClawMeta === "object" && !Array.isArray(openClawMeta)
      ? (openClawMeta as Record<string, unknown>)
      : null;
  return typeof transcriptMeta?.id === "string" && transcriptMeta.id.trim()
    ? transcriptMeta.id
    : undefined;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
  );
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}

export function isToolCardError(card: ToolCard): boolean {
  if (card.isError !== undefined) {
    return card.isError;
  }
  return isToolErrorOutput(card.outputText);
}

export function extractToolPreview(
  outputText: string | undefined,
  toolName: string | undefined,
): ToolCard["preview"] | undefined {
  return extractCanvasFromText(outputText, toolName);
}

function resolveToolCardId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  prefix = "tool",
): string {
  const explicitId =
    (typeof item.id === "string" && item.id.trim()) ||
    (typeof item.toolCallId === "string" && item.toolCallId.trim()) ||
    (typeof item.tool_call_id === "string" && item.tool_call_id.trim()) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    "";
  if (explicitId) {
    return `${prefix}:${explicitId}`;
  }
  const name =
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool";
  return `${prefix}:${name}:${index}`;
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint") {
      return String(args);
    }
    if (typeof args === "symbol") {
      return args.description ? `Symbol(${args.description})` : "Symbol()";
    }
    return Object.prototype.toString.call(args);
  }
}

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const withoutConnector = normalized.replace(/^with\s+/i, "").trim();
  return withoutConnector || normalized;
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  const normalized = formatCollapsedToolSummaryText(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 120);
}

function findFirstUnmatchedCard(
  cards: ToolCard[],
  id: string,
  name: string,
  fallbackMatchedCards: WeakSet<ToolCard>,
): ToolCard | undefined {
  let nameOnlyCandidate: ToolCard | undefined;
  for (const card of cards) {
    if (card.id === id) {
      return card;
    }
    if (
      !nameOnlyCandidate &&
      card.name === name &&
      card.outputText === undefined &&
      !fallbackMatchedCards.has(card)
    ) {
      nameOnlyCandidate = card;
    }
  }
  return nameOnlyCandidate;
}

export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const cards: ToolCard[] = [];
  const fallbackMatchedCards = new WeakSet<ToolCard>();
  const transcriptMessageId = resolveTranscriptMessageId(m);

  for (let index = 0; index < content.length; index++) {
    const item = content[index] ?? {};
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" &&
        (item.arguments != null || item.args != null || item.input != null));
    if (isToolCall) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        name: typeof item.name === "string" ? item.name : "tool",
        args,
        inputText: serializeToolInput(args),
        messageId: transcriptMessageId,
      });
      continue;
    }

    if (kind === "toolresult" || kind === "tool_result") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const cardId = resolveToolCardId(item, m, index, prefix);
      const existing = findFirstUnmatchedCard(cards, cardId, name, fallbackMatchedCards);
      const text = extractToolText(item);
      const preview = extractToolPreview(text, name);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      if (existing) {
        fallbackMatchedCards.add(existing);
        existing.outputText = text;
        existing.preview = preview;
        if (isError !== undefined) {
          existing.isError = isError;
        }
        continue;
      }
      cards.push({
        id: cardId,
        name,
        outputText: text,
        messageId: transcriptMessageId,
        ...(isError !== undefined ? { isError } : {}),
        preview,
      });
    }
  }

  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const isStandaloneToolMessage =
    isToolResultMessage(message) ||
    role === "tool" ||
    role === "function" ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";

  if (isStandaloneToolMessage && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      name,
      outputText: text,
      messageId: transcriptMessageId,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
      preview: extractToolPreview(text, name),
    });
  }

  return cards;
}

const toolCardsByMessage = new WeakMap<object, Map<string, ToolCard[]>>();

export function extractToolCardsCached(message: unknown, prefix = "tool"): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCards(message, prefix);
  }
  let byPrefix = toolCardsByMessage.get(message);
  if (!byPrefix) {
    byPrefix = new Map();
    toolCardsByMessage.set(message, byPrefix);
  }
  const cached = byPrefix.get(prefix);
  if (cached) {
    return cached;
  }
  const cards = extractToolCards(message, prefix);
  byPrefix.set(prefix, cards);
  return cards;
}
