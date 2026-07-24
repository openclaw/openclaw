/**
 * Strips OpenClaw-injected inbound metadata blocks from a user-role message
 * text before it is displayed in any UI surface (TUI, webchat, macOS app) or
 * replayed as historical context to the model.
 *
 * Background: `buildInboundUserContextPrefix` in `inbound-meta.ts` prepends
 * structured metadata blocks (Conversation info, Sender info, reply context,
 * etc.) directly to the stored user message content so the LLM can access
 * them. These blocks are current-turn AI-facing context only and must never
 * surface in user-visible chat history or accumulate in historical prompt
 * replay.
 *
 * Also strips the timestamp prefix injected by `injectTimestamp` so UI surfaces
 * do not show AI-facing envelope metadata as user text.
 */

import { MESSAGE_TOOL_DELIVERY_HINTS } from "./delivery-hints.js";

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

const CHAT_HISTORY_SENTINEL = "Chat history since last reply:";

/**
 * Sentinel strings that identify the start of an injected metadata block.
 * Must stay in sync with `buildInboundUserContextPrefix` in `inbound-meta.ts`.
 *
 * Accepted tradeoff of the plain labels: a block is recognized by an EXACT label
 * match plus the required ```json fence on the next line. A user who types one of
 * these exact labels on its own line immediately before a ```json fence would have
 * that span stripped from rendered/replayed history (never from the processed
 * message). Realistically only `Sender:` collides with natural text; eliminating
 * it entirely would require a forgeable-proof provenance marker on every emitted
 * block, which the plain-label design deliberately avoids.
 */
const INBOUND_META_SENTINELS = [
  "Conversation info:",
  // This removed block remains a recognized structural label for replay/UI stripping.
  "Sender:",
  "Thread starter:",
  "Reply target of current user message:",
  "Forwarded message context:",
  CHAT_HISTORY_SENTINEL,
] as const;

const CONTEXT_HEADER = "Context:";
const CHAT_WINDOW_CONTEXT_FAST_SENTINEL = "(chronological";
const CHAT_WINDOW_CONTEXT_HEADER_RE = /^.+ \(chronological(?:, [^)]+)?\):$/;
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";
const [CONVERSATION_INFO_SENTINEL, SENDER_INFO_SENTINEL] = INBOUND_META_SENTINELS;

// Pre-compiled fast-path regex — avoids line-by-line parse when no blocks present.
const SENTINEL_FAST_RE = new RegExp(
  [
    ...INBOUND_META_SENTINELS,
    ...MESSAGE_TOOL_DELIVERY_HINTS,
    CONTEXT_HEADER,
    CHAT_WINDOW_CONTEXT_FAST_SENTINEL,
  ]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
);

/** Fast check for whether text contains any inbound metadata sentinel. */
export function hasInboundMetadataSentinel(text: string): boolean {
  return Boolean(text && SENTINEL_FAST_RE.test(text));
}

function isMessageToolDeliveryHintLine(line: string): boolean {
  const trimmed = line.trim();
  return MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint === trimmed);
}

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function isChatWindowContextHeaderLine(line: string): boolean {
  return CHAT_WINDOW_CONTEXT_HEADER_RE.test(line.trim());
}

function skipChatWindowContextBlock(lines: string[], index: number): number {
  let next = index + 1;
  while (next < lines.length && lines[next]?.trim() !== "") {
    next++;
  }
  while (next < lines.length && lines[next]?.trim() === "") {
    next++;
  }
  return next;
}

function restoreNeutralizedMarkdownFences(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll("`\u200b``", "```");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => restoreNeutralizedMarkdownFences(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, restoreNeutralizedMarkdownFences(entry)]),
  );
}

function parseJsonObjectRecord(jsonText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseInboundMetaBlock(lines: string[], sentinel: string): Record<string, unknown> | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== sentinel) {
      continue;
    }
    if (lines[i + 1]?.trim() !== "```json") {
      return null;
    }
    let end = i + 2;
    while (end < lines.length && lines[end]?.trim() !== "```") {
      end += 1;
    }
    if (end >= lines.length) {
      return null;
    }
    const jsonText = lines
      .slice(i + 2, end)
      .join("\n")
      .trim();
    if (!jsonText) {
      return null;
    }
    const parsed = parseJsonObjectRecord(jsonText);
    return parsed ? (restoreNeutralizedMarkdownFences(parsed) as Record<string, unknown>) : null;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function shouldStripTrailingContextBlock(lines: string[], index: number): boolean {
  if (lines[index]?.trim() !== CONTEXT_HEADER) {
    return false;
  }
  // Only OpenClaw-injected channel context qualifies. Its sole producer wraps
  // every entry with `wrapExternalContent`, whose opening marker carries a
  // per-call random id and cannot be forged by inbound text; `Source:`/`Channel
  // metadata (` only ever appear *inside* that envelope. Match the marker as the
  // first non-empty line, never those weaker cues, so a bare `Context:` a user
  // typed — even one followed by `Source: <url>` prose — cannot truncate their
  // own message.
  for (let probe = index + 1; probe < Math.min(lines.length, index + 8); probe += 1) {
    const trimmed = lines[probe]?.trim() ?? "";
    if (trimmed === "") {
      continue;
    }
    return trimmed.startsWith("<<<EXTERNAL_UNTRUSTED_CONTENT");
  }
  return false;
}

function stripTrailingContextBlockSuffix(lines: string[]): string[] {
  for (let i = 0; i < lines.length; i++) {
    if (!shouldStripTrailingContextBlock(lines, i)) {
      continue;
    }
    let end = i;
    while (end > 0 && lines[end - 1]?.trim() === "") {
      end -= 1;
    }
    return lines.slice(0, end);
  }
  return lines;
}

function stripActiveMemoryPromptPrefixBlocks(lines: string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index);
    if (line === undefined) {
      break;
    }
    if (line.trim() === CONTEXT_HEADER && lines[index + 1]?.trim() === ACTIVE_MEMORY_OPEN_TAG) {
      let closeIndex = -1;
      for (let probe = index + 2; probe < lines.length; probe += 1) {
        if (lines[probe]?.trim() === ACTIVE_MEMORY_CLOSE_TAG) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        index = closeIndex;
        while (index + 1 < lines.length && lines[index + 1]?.trim() === "") {
          index += 1;
        }
        continue;
      }
    }

    result.push(line);
  }

  return result;
}

/**
 * Remove all injected inbound metadata prefix blocks from `text`.
 *
 * Each block has the shape:
 *
 * ```
 * <sentinel-line>
 * ```json
 * { … }
 * ```
 * ```
 *
 * Returns the original string reference unchanged when no metadata is present
 * (fast path — zero allocation).
 */
/** Strips all injected inbound metadata blocks from user-visible text. */
export function stripInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }

  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) {
    return withoutTimestamp;
  }

  const lines = withoutTimestamp.split("\n");
  const strippedLeadingPrefixLines = stripActiveMemoryPromptPrefixBlocks(lines);
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < strippedLeadingPrefixLines.length; i++) {
    const line = strippedLeadingPrefixLines.at(i);
    if (line === undefined) {
      break;
    }
    // Channel context is appended by OpenClaw as a terminal metadata suffix.
    // When this structured header appears, drop it and everything that follows.
    if (!inMetaBlock && shouldStripTrailingContextBlock(strippedLeadingPrefixLines, i)) {
      break;
    }

    if (!inMetaBlock && isMessageToolDeliveryHintLine(line)) {
      continue;
    }

    if (!inMetaBlock && isChatWindowContextHeaderLine(line)) {
      i = skipChatWindowContextBlock(strippedLeadingPrefixLines, i) - 1;
      continue;
    }

    // Detect start of a metadata block.
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      const next = strippedLeadingPrefixLines[i + 1];
      if (next?.trim() !== "```json") {
        if (line.trim() === CHAT_HISTORY_SENTINEL) {
          i = skipChatWindowContextBlock(strippedLeadingPrefixLines, i) - 1;
          continue;
        }
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Blank separator lines between consecutive blocks are dropped.
      if (line.trim() === "") {
        continue;
      }
      // Unexpected non-blank line outside a fence — treat as user content.
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

/** Strips only leading inbound metadata blocks while preserving later user text. */
export function stripLeadingInboundMetadata(text: string): string {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return text;
  }

  const lines = stripActiveMemoryPromptPrefixBlocks(text.split("\n"));
  let index = 0;

  while (lines.at(index) === "") {
    index++;
  }
  const firstLine = lines.at(index);
  if (firstLine === undefined) {
    return "";
  }

  const strippedDeliveryHint = isMessageToolDeliveryHintLine(firstLine);
  while (true) {
    const line = lines.at(index);
    if (line === undefined || !isMessageToolDeliveryHintLine(line)) {
      break;
    }
    index++;
    while (lines.at(index) === "") {
      index++;
    }
  }
  const firstContentLine = lines.at(index);
  if (firstContentLine === undefined) {
    return "";
  }

  if (
    !isInboundMetaSentinelLine(firstContentLine) &&
    !isChatWindowContextHeaderLine(firstContentLine)
  ) {
    const strippedNoLeading = stripTrailingContextBlockSuffix(
      strippedDeliveryHint ? lines.slice(index) : lines,
    );
    return strippedNoLeading.join("\n");
  }

  while (index < lines.length) {
    const line = lines.at(index);
    if (line === undefined) {
      break;
    }
    if (isChatWindowContextHeaderLine(line)) {
      index = skipChatWindowContextBlock(lines, index);
      continue;
    }
    if (!isInboundMetaSentinelLine(line)) {
      break;
    }

    if (line.trim() === CHAT_HISTORY_SENTINEL && lines[index + 1]?.trim() !== "```json") {
      index = skipChatWindowContextBlock(lines, index);
      continue;
    }

    index++;
    if (lines.at(index)?.trim() === "```json") {
      index++;
      while (index < lines.length && lines.at(index)?.trim() !== "```") {
        index++;
      }
      if (lines.at(index)?.trim() === "```") {
        index++;
      }
    } else {
      return text;
    }

    while (lines.at(index)?.trim() === "") {
      index++;
    }
  }

  const strippedRemainder = stripTrailingContextBlockSuffix(lines.slice(index));
  return strippedRemainder.join("\n");
}

/** Extracts the sender label from injected inbound metadata when present. */
export function extractInboundSenderLabel(text: string): string | null {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return null;
  }

  const lines = text.split("\n");
  const senderInfo = parseInboundMetaBlock(lines, SENDER_INFO_SENTINEL);
  const conversationInfo = parseInboundMetaBlock(lines, CONVERSATION_INFO_SENTINEL);
  const conversationSender = conversationInfo?.sender;
  const conversationSenderFields =
    conversationSender &&
    typeof conversationSender === "object" &&
    !Array.isArray(conversationSender)
      ? [
          (conversationSender as Record<string, unknown>)["name"],
          (conversationSender as Record<string, unknown>)["username"],
          (conversationSender as Record<string, unknown>)["e164"],
          (conversationSender as Record<string, unknown>)["id"],
        ]
      : [conversationSender];
  return firstNonEmptyString(
    senderInfo?.label,
    senderInfo?.name,
    senderInfo?.username,
    senderInfo?.e164,
    senderInfo?.id,
    ...conversationSenderFields,
  );
}
