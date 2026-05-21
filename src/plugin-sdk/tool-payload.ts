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
const HARMONY_CHANNEL_MARKER = "<|channel|>";
const HARMONY_MESSAGE_MARKER = "<|message|>";
const HARMONY_CALL_MARKER = "<|call|>";
const GEMMA_CALL_OPENING = "<|tool_call>call:";
const GEMMA_CALL_CLOSING = "<tool_call|>";
const GEMMA_CALL_CLOSING_RESPONSE = "<|tool_response>";

enum ToolCallFormat {
  Bracket,
  Harmony,
  Gemma,
}

type PlainTextToolCallOpening = {
  format: ToolCallFormat;
  end: number;
  name: string;
};

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

function parseBracketOpening(text: string, start: number): PlainTextToolCallOpening | null {
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
  return { format: ToolCallFormat.Bracket, end: afterLineBreak, name };
}

function parseHarmonyOpening(text: string, start: number): PlainTextToolCallOpening | null {
  let cursor = start;
  if (text.startsWith(HARMONY_CHANNEL_MARKER, cursor)) {
    cursor += HARMONY_CHANNEL_MARKER.length;
  }
  const channelStart = cursor;
  while (/[A-Za-z_]/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  const channel = text.slice(channelStart, cursor);
  if (channel !== "commentary" && channel !== "analysis" && channel !== "final") {
    return null;
  }
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
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("code", cursor)) {
    return null;
  }
  cursor += 4;
  cursor = skipWhitespace(text, cursor);
  if (text.startsWith(HARMONY_MESSAGE_MARKER, cursor)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  }
  return { format: ToolCallFormat.Harmony, end: cursor, name };
}

function parseGemmaOpening(text: string, start: number): PlainTextToolCallOpening | null {
  let cursor = start;
  if (!text.startsWith(GEMMA_CALL_OPENING, cursor)) {
    return null;
  }
  cursor += GEMMA_CALL_OPENING.length;
  let nameStart = cursor;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }
  const name = text.slice(nameStart, cursor);
  if (text[cursor] !== "{") {
    return null;
  }
  return { format: ToolCallFormat.Gemma, end: cursor, name };
}

function parseOpening(text: string, start: number): PlainTextToolCallOpening | null {
  return (
    parseBracketOpening(text, start) ??
    parseHarmonyOpening(text, start) ??
    parseGemmaOpening(text, start)
  );
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

/**
 * Recursively parses Gemma's proprietary argument format, converting
 * `<|"|>string<|"|>`, unquoted keys, standard strings, and primitives into a JS object.
 * Ref: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
 */
function parseGemmaValue(text: string, cursor: number): { value: unknown; end: number } | null {
  cursor = skipWhitespace(text, cursor);
  if (cursor >= text.length) {
    return null;
  }
  if (text.startsWith('<|"|>', cursor)) {
    const startStr = cursor + 5;
    const endStr = text.indexOf('<|"|>', startStr);
    if (endStr === -1) {
      return null;
    }
    return { value: text.slice(startStr, endStr), end: endStr + 5 };
  }
  if (text[cursor] === '"' || text[cursor] === "'") {
    const quoteChar = text[cursor];
    let strEnd = cursor + 1;
    while (strEnd < text.length) {
      if (text[strEnd] === quoteChar && text[strEnd - 1] !== "\\") {
        break;
      }
      strEnd++;
    }
    if (strEnd >= text.length) {
      return null;
    }
    const rawVal = text.slice(cursor + 1, strEnd).replace(/\\(.)/g, "$1");
    return { value: rawVal, end: strEnd + 1 };
  }
  if (text[cursor] === "{") {
    const obj: Record<string, unknown> = {};
    cursor++;
    while (cursor < text.length) {
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "}") {
        return { value: obj, end: cursor + 1 };
      }
      const keyMatch = text.slice(cursor).match(/^(?:["'])?([A-Za-z0-9_-]+)(?:["'])?\s*:/);
      if (!keyMatch) {
        return null;
      }
      const key = keyMatch[1];
      cursor += keyMatch[0].length;
      const valResult = parseGemmaValue(text, cursor);
      if (!valResult) {
        return null;
      }
      obj[key] = valResult.value;
      cursor = valResult.end;
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === ",") {
        cursor++;
      } else if (text[cursor] !== "}") {
        return null;
      }
    }
    return null;
  }
  if (text[cursor] === "[") {
    const arr: unknown[] = [];
    cursor++;
    while (cursor < text.length) {
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === "]") {
        return { value: arr, end: cursor + 1 };
      }
      const valResult = parseGemmaValue(text, cursor);
      if (!valResult) {
        return null;
      }
      arr.push(valResult.value);
      cursor = valResult.end;
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] === ",") {
        cursor++;
      } else if (text[cursor] !== "]") {
        return null;
      }
    }
    return null;
  }
  const primitiveMatch = text.slice(cursor).match(/^[^,}\]\s]+/);
  if (!primitiveMatch) {
    return null;
  }
  const rawVal = primitiveMatch[0];
  cursor += rawVal.length;
  if (rawVal === "true") {
    return { value: true, end: cursor };
  }
  if (rawVal === "false") {
    return { value: false, end: cursor };
  }
  if (rawVal === "null") {
    return { value: null, end: cursor };
  }
  const num = Number(rawVal);
  if (!Number.isNaN(num)) {
    return { value: num, end: cursor };
  }
  return { value: rawVal, end: cursor };
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

function parseOptionalHarmonyClosing(text: string, start: number): number {
  const cursor = skipWhitespace(text, start);
  if (text.startsWith(HARMONY_CALL_MARKER, cursor)) {
    return cursor + HARMONY_CALL_MARKER.length;
  }
  return start;
}

function parsePlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  const opening = parseOpening(text, start);
  if (!opening) {
    return null;
  }
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(opening.name)) {
    return null;
  }
  if (opening.format == ToolCallFormat.Bracket || opening.format == ToolCallFormat.Harmony) {
    const payload = consumeJsonObject(
      text,
      opening.end,
      options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES,
    );
    if (!payload) {
      return null;
    }
    const closingEnd =
      opening.format == ToolCallFormat.Bracket
        ? parseClosing(text, payload.end, opening.name)
        : parseOptionalHarmonyClosing(text, payload.end);
    if (closingEnd === null) {
      return null;
    }
    return {
      arguments: payload.value,
      end: closingEnd,
      name: opening.name,
      raw: text.slice(start, closingEnd),
      start,
    };
  } else if (opening.format == ToolCallFormat.Gemma) {
    const parsedPayload = parseGemmaValue(text, opening.end);
    if (!parsedPayload) {
      return null;
    }
    let cursor = skipWhitespace(text, parsedPayload.end);
    if (!text.startsWith(GEMMA_CALL_CLOSING, cursor)) {
      return null;
    }
    let closingEnd = cursor + GEMMA_CALL_CLOSING.length;
    if (text.startsWith(GEMMA_CALL_CLOSING_RESPONSE, closingEnd)) {
      closingEnd += GEMMA_CALL_CLOSING_RESPONSE.length;
    }
    if (
      closingEnd - start >
      (options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES)
    ) {
      return null;
    }
    return {
      arguments: parsedPayload.value as Record<string, unknown>,
      end: closingEnd,
      name: opening.name,
      raw: text.slice(start, closingEnd),
      start,
    };
  }
  return null;
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
  if (
    !text ||
    (!/\[[A-Za-z0-9_-]+\]/.test(text) &&
      !/(?:^|\n)\s*(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=/.test(text) &&
      !text.includes("<|tool_call>call:"))
  ) {
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
    const afterBlockLineBreak = consumeLineBreak(text, cursor);
    if (afterBlockLineBreak !== null) {
      cursor = afterBlockLineBreak;
    }
    index = cursor;
  }
  result += text.slice(cursor);
  return result;
}
