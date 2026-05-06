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

const HARMONY_CHANNELS = ["commentary", "analysis", "final"];
const HARMONY_DELIMITER_RE = /^<\|[a-z]+\|>/;

/**
 * Parse a Harmony-format tool-call opening. Two shapes:
 *   1. `commentary to=<name> code {json}`
 *   2. `<|channel|>commentary to=<name> code<|message|>{json}`
 *
 * Returns the tool name and cursor position just before the JSON payload.
 */
function parseHarmonyOpening(text: string, start: number): { end: number; name: string } | null {
  let cursor = start;

  // Consume optional leading <|channel|> delimiter.
  const delimMatch = HARMONY_DELIMITER_RE.exec(text.slice(cursor));
  if (delimMatch) {
    cursor += delimMatch[0].length;
  }

  // Expect one of the known harmony channel keywords.
  let matched = false;
  for (const channel of HARMONY_CHANNELS) {
    if (text.startsWith(channel, cursor)) {
      cursor += channel.length;
      matched = true;
      break;
    }
  }
  if (!matched) {
    return null;
  }

  // Expect ` to=<name>` (with mandatory space before "to").
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("to=", cursor)) {
    return null;
  }
  cursor += 3;
  const nameStart = cursor;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }
  const name = text.slice(nameStart, cursor);

  // Expect ` code` keyword after the tool name.
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("code", cursor)) {
    return null;
  }
  cursor += 4;

  // Consume optional <|message|> delimiter before JSON.
  cursor = skipHorizontalWhitespace(text, cursor);
  const msgDelim = HARMONY_DELIMITER_RE.exec(text.slice(cursor));
  if (msgDelim) {
    cursor += msgDelim[0].length;
  }

  // Skip any remaining whitespace before the JSON object.
  cursor = skipWhitespace(text, cursor);

  return { end: cursor, name };
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

const HARMONY_TRAILING_RE = /^<\|(?:end|return|message)\|>/;

function consumeHarmonyTrailing(text: string, start: number): number {
  let cursor = skipHorizontalWhitespace(text, start);
  const trailing = HARMONY_TRAILING_RE.exec(text.slice(cursor));
  if (trailing) {
    cursor += trailing[0].length;
  }
  return cursor;
}

function parsePlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  const opening = parseOpening(text, start);
  const harmonyOpening = opening ? null : parseHarmonyOpening(text, start);
  const resolved = opening ?? harmonyOpening;
  if (!resolved) {
    return null;
  }
  const isHarmony = harmonyOpening !== null;
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(resolved.name)) {
    return null;
  }
  const payload = consumeJsonObject(
    text,
    resolved.end,
    options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES,
  );
  if (!payload) {
    return null;
  }
  let end: number;
  if (isHarmony) {
    end = consumeHarmonyTrailing(text, payload.end);
  } else {
    const closingEnd = parseClosing(text, payload.end, resolved.name);
    if (closingEnd === null) {
      return null;
    }
    end = closingEnd;
  }
  return {
    arguments: payload.value,
    end,
    name: resolved.name,
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
  if (!text || !/\[[A-Za-z0-9_-]+\]/.test(text)) {
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
