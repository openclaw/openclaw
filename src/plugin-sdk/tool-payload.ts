type ToolPayloadTextBlock = {
  type: "text";
  text: string;
};

export type ToolPayloadCarrier = {
  details?: unknown;
  content?: unknown;
};

function isToolPayloadTextBlock(block: unknown): block is ToolPayloadTextBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export function extractToolPayload(result: ToolPayloadCarrier | null | undefined): unknown {
  if (!result) {
    return undefined;
  }
  if (result.details !== undefined) {
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(isToolPayloadTextBlock)
    : undefined;
  const text = textBlock?.text;
  if (!text) {
    return result.content ?? result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type PlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  end: number;
  name: string;
  raw: string;
  start: number;
};

export type PlainTextToolCallParseOptions = {
  allowedToolNames?: Iterable<string>;
  maxPayloadBytes?: number;
};

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";

function isToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

function parseOpening(text: string, start: number): { end: number; name: string } | null {
  if (text[start] !== "[") {
    return null;
  }
  let cursor = start + 1;
  const nameStart = cursor;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart || text[cursor] !== "]") {
    return null;
  }
  const name = text.slice(nameStart, cursor);
  cursor += 1;
  cursor = skipHorizontalWhitespace(text, cursor);
  const afterLineBreak = consumeLineBreak(text, cursor);
  if (afterLineBreak === null) {
    return null;
  }
  return { end: afterLineBreak, name };
}

function consumeJsonObject(
  text: string,
  start: number,
  maxPayloadBytes: number,
): { end: number; value: Record<string, unknown> } | null {
  const cursor = skipWhitespace(text, start);
  if (text[cursor] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = cursor; index < text.length; index += 1) {
    const char = text[index];
    if (index + 1 - cursor > maxPayloadBytes) {
      return null;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const rawJson = text.slice(cursor, index + 1);
        try {
          const parsed = JSON.parse(rawJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
          }
          return { end: index + 1, value: parsed as Record<string, unknown> };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseClosing(text: string, start: number, name: string): number | null {
  const cursor = skipWhitespace(text, start);
  if (text.startsWith(END_TOOL_REQUEST, cursor)) {
    return cursor + END_TOOL_REQUEST.length;
  }
  const namedClosing = `[/${name}]`;
  if (text.startsWith(namedClosing, cursor)) {
    return cursor + namedClosing.length;
  }
  return null;
}

// Recognize OpenAI Harmony-format tool-call openings emitted by gpt-oss models
// when the inference server's chat-template wrapping leaks the model's native
// syntax through as plain text (rather than promoting it back to a structured
// tool_calls array). Examples seen from gpt-oss-120b on LM Studio:
//   "commentary to=exec code {\"command\":\"ls\"}"
//   "<|channel|>commentary to=exec code<|message|>{\"command\":\"ls\"}"
//   "analysis to=read code {\"path\":\"/tmp/x\"}"
// The tool name may be unprefixed or "functions.<name>"; we strip the prefix.
const HARMONY_OPENING_RE =
  /^(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=(?:functions\.)?([A-Za-z0-9_.-]+)(?:\s+code)?(?:<\|message\|>)?\s*/;
const HARMONY_TRAILING_RE = /^\s*<\|(?:end|return|message)\|>/;

// Cheap detection — both the bracket prefix `[name]` and any harmony channel
// keyword followed by `to=`.  Used by callers (strip + LM Studio buffer) that
// want to fast-path skip the full parser when the text obviously contains no
// tool-call shape.
const PLAIN_TEXT_TOOL_CALL_PREFIX_DETECT_RE =
  /\[[A-Za-z0-9_-]+\]|(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=/;

/**
 * Returns true if the given assistant text contains anything that could be a
 * plain-text tool-call opening — either the historical bracket form or one of
 * the OpenAI Harmony channel forms.
 *
 * Designed as a cheap pre-check: callers use it to bypass the full parser when
 * the text demonstrably contains no tool-call shape.  A `true` return does NOT
 * imply the text is a valid tool call; only that it is worth running the full
 * parser to find out.
 */
export function containsPlainTextToolCallOpening(text: string): boolean {
  return Boolean(text) && PLAIN_TEXT_TOOL_CALL_PREFIX_DETECT_RE.test(text);
}

/**
 * Streaming-side predicate: while a partial assistant text is being streamed,
 * return true if the buffer could still resolve into a plain-text tool call.
 * When this returns false, the streaming layer is free to flush the buffered
 * text events to the user without holding them back for promotion at done.
 *
 * Recognizes both the historical bracket form (`[name]\n{json}\n[/name]`) and
 * the OpenAI Harmony shapes (bare `commentary`/`analysis`/`final` channel
 * keywords or the delimited `<|channel|>` form).  Permissive at the prefix:
 * if the buffer is short and starts with one of the channel keywords, it is
 * held back until either the full pattern can be parsed (promote at done)
 * or the message ends without a match (flush at done).
 */
export function couldStillBePlainTextToolCallPrefix(
  text: string,
  options?: { maxPayloadBytes?: number },
): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const maxBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  if (text.length > maxBytes) {
    return false;
  }
  const trimmed = text.trimStart();
  if (trimmed.length === 0) {
    return true;
  }
  if (trimmed.startsWith("[")) {
    return true;
  }
  if (trimmed.startsWith("<|")) {
    return true;
  }
  // Bare-channel harmony: starts with one of the harmony channel keywords.
  // Be permissive — if the channel is present we accept the buffer as a
  // plausible tool-call prefix even before `to=...code` is fully streamed.
  return /^(?:commentary|analysis|final)(?:\s|$)/.test(trimmed);
}

function parseHarmonyOpening(text: string, start: number): { end: number; name: string } | null {
  const slice = text.slice(start, start + 256);
  const match = slice.match(HARMONY_OPENING_RE);
  if (!match) {
    return null;
  }
  return { end: start + match[0].length, name: match[1] };
}

function parsePlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  let opening = parseOpening(text, start);
  let isHarmony = false;
  if (!opening) {
    opening = parseHarmonyOpening(text, start);
    if (!opening) {
      return null;
    }
    isHarmony = true;
  }
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(opening.name)) {
    return null;
  }
  const payload = consumeJsonObject(
    text,
    opening.end,
    options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES,
  );
  if (!payload) {
    return null;
  }
  let end: number;
  if (isHarmony) {
    // Harmony format has no required closing tag — the block ends at the JSON
    // close. Optionally consume a trailing harmony message-end delimiter so
    // strip operations leave clean text behind.
    end = payload.end;
    const trailSlice = text.slice(payload.end, payload.end + 16);
    const trailMatch = trailSlice.match(HARMONY_TRAILING_RE);
    if (trailMatch) {
      end = payload.end + trailMatch[0].length;
    }
  } else {
    const closeEnd = parseClosing(text, payload.end, opening.name);
    if (closeEnd === null) {
      return null;
    }
    end = closeEnd;
  }
  return {
    arguments: payload.value,
    end,
    name: opening.name,
    raw: text.slice(start, end),
    start,
  };
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const block = parsePlainTextToolCallBlockAt(text, cursor, options);
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

export function stripPlainTextToolCallBlocks(text: string): string {
  if (!containsPlainTextToolCallOpening(text)) {
    return text;
  }
  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === "\n";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const blockStart = skipHorizontalWhitespace(text, index);
    const block = parsePlainTextToolCallBlockAt(text, blockStart);
    if (!block) {
      index += 1;
      continue;
    }
    result += text.slice(cursor, index);
    cursor = block.end;
    index = block.end;
  }
  result += text.slice(cursor);
  return result;
}
