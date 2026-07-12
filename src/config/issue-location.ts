import path from "node:path";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { ConfigValidationIssue } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

export type ConfigIssuePathSegment = string | number;

type JsonCursor = {
  pos: number;
};

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function lineNumberAtOffset(raw: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < raw.length; index += 1) {
    if (raw[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function skipJsonWhitespaceAndComments(raw: string, cursor: JsonCursor): void {
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (char === undefined) {
      break;
    }
    if (isJsonWhitespace(char)) {
      cursor.pos += 1;
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "/") {
      cursor.pos += 2;
      while (cursor.pos < raw.length && raw[cursor.pos] !== "\n") {
        cursor.pos += 1;
      }
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "*") {
      cursor.pos += 2;
      while (cursor.pos < raw.length - 1) {
        if (raw[cursor.pos] === "*" && raw[cursor.pos + 1] === "/") {
          cursor.pos += 2;
          break;
        }
        cursor.pos += 1;
      }
      continue;
    }
    break;
  }
}

function skipJsonString(raw: string, cursor: JsonCursor, quote: '"' | "'"): void {
  cursor.pos += 1;
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (char === "\\") {
      cursor.pos += 2;
      continue;
    }
    if (char === quote) {
      cursor.pos += 1;
      return;
    }
    cursor.pos += 1;
  }
}

function skipJsonLiteral(raw: string, cursor: JsonCursor): void {
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (char === undefined) {
      return;
    }
    if (
      char === "," ||
      char === "}" ||
      char === "]" ||
      isJsonWhitespace(char) ||
      (char === "/" && (raw[cursor.pos + 1] === "/" || raw[cursor.pos + 1] === "*"))
    ) {
      return;
    }
    cursor.pos += 1;
  }
}

function skipJsonComposite(raw: string, cursor: JsonCursor, open: "{" | "["): void {
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString: '"' | "'" | null = null;
  while (cursor.pos < raw.length) {
    const char = raw[cursor.pos];
    if (inString) {
      if (char === "\\") {
        cursor.pos += 2;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      cursor.pos += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      cursor.pos += 1;
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "/") {
      cursor.pos += 2;
      while (cursor.pos < raw.length && raw[cursor.pos] !== "\n") {
        cursor.pos += 1;
      }
      continue;
    }
    if (char === "/" && raw[cursor.pos + 1] === "*") {
      cursor.pos += 2;
      while (cursor.pos < raw.length - 1) {
        if (raw[cursor.pos] === "*" && raw[cursor.pos + 1] === "/") {
          cursor.pos += 2;
          break;
        }
        cursor.pos += 1;
      }
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      cursor.pos += 1;
      if (depth === 0) {
        return;
      }
      continue;
    }
    cursor.pos += 1;
  }
}

function skipJsonValue(raw: string, cursor: JsonCursor): void {
  skipJsonWhitespaceAndComments(raw, cursor);
  if (cursor.pos >= raw.length) {
    return;
  }
  const char = raw[cursor.pos];
  if (char === undefined) {
    return;
  }
  if (char === "{" || char === "[") {
    skipJsonComposite(raw, cursor, char);
    return;
  }
  if (char === '"' || char === "'") {
    skipJsonString(raw, cursor, char);
    return;
  }
  skipJsonLiteral(raw, cursor);
}

function readJsonStringToken(raw: string, cursor: JsonCursor): string | null {
  skipJsonWhitespaceAndComments(raw, cursor);
  const char = raw[cursor.pos];
  if (char !== '"' && char !== "'") {
    return null;
  }
  cursor.pos += 1;
  let value = "";
  while (cursor.pos < raw.length) {
    const current = raw[cursor.pos];
    if (current === "\\") {
      const escaped = raw[cursor.pos + 1];
      if (escaped === undefined) {
        return null;
      }
      value += escaped;
      cursor.pos += 2;
      continue;
    }
    if (current === char) {
      cursor.pos += 1;
      return value;
    }
    value += current;
    cursor.pos += 1;
  }
  return null;
}

function readJsonIdentifierToken(raw: string, cursor: JsonCursor): string | null {
  skipJsonWhitespaceAndComments(raw, cursor);
  const start = cursor.pos;
  if (start >= raw.length) {
    return null;
  }
  const first = raw[start];
  if (first === undefined || !/[A-Za-z_$]/.test(first)) {
    return null;
  }
  cursor.pos += 1;
  while (cursor.pos < raw.length) {
    const current = raw[cursor.pos];
    if (current === undefined || !/[A-Za-z0-9_$]/.test(current)) {
      break;
    }
    cursor.pos += 1;
  }
  return raw.slice(start, cursor.pos);
}

function readJsonObjectKey(raw: string, cursor: JsonCursor): string | null {
  skipJsonWhitespaceAndComments(raw, cursor);
  const char = raw[cursor.pos];
  if (char === '"' || char === "'") {
    return readJsonStringToken(raw, cursor);
  }
  return readJsonIdentifierToken(raw, cursor);
}

function expectJsonChar(raw: string, cursor: JsonCursor, expected: string): boolean {
  skipJsonWhitespaceAndComments(raw, cursor);
  if (raw[cursor.pos] !== expected) {
    return false;
  }
  cursor.pos += 1;
  return true;
}

function valuesRoughlyMatch(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function locateJsonPathValueOffset(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
  expectedValue?: unknown,
): number | undefined {
  if (segments.length === 0 || raw.trim().length === 0) {
    return undefined;
  }
  const cursor: JsonCursor = { pos: 0 };
  skipJsonWhitespaceAndComments(raw, cursor);
  return locateJsonPathValueOffsetAtCurrent(raw, cursor, segments, 0, expectedValue);
}

function locateJsonPathValueOffsetAtCurrent(
  raw: string,
  cursor: JsonCursor,
  segments: readonly ConfigIssuePathSegment[],
  depth: number,
  expectedValue?: unknown,
): number | undefined {
  const segment = segments[depth];
  const isLeaf = depth === segments.length - 1;

  if (typeof segment === "number") {
    if (!expectJsonChar(raw, cursor, "[")) {
      return undefined;
    }
    for (let index = 0; index < segment; index += 1) {
      skipJsonValue(raw, cursor);
      if (!expectJsonChar(raw, cursor, ",")) {
        return undefined;
      }
    }
    if (isLeaf) {
      skipJsonWhitespaceAndComments(raw, cursor);
      const valueOffset = cursor.pos;
      if (
        expectedValue !== undefined &&
        !valuesRoughlyMatch(peekJsonValueAt(raw, cursor), expectedValue)
      ) {
        return undefined;
      }
      return valueOffset;
    }
    return locateJsonPathValueOffsetAtCurrent(raw, cursor, segments, depth + 1, expectedValue);
  }

  if (!expectJsonChar(raw, cursor, "{")) {
    return undefined;
  }
  while (cursor.pos < raw.length) {
    skipJsonWhitespaceAndComments(raw, cursor);
    if (raw[cursor.pos] === "}") {
      return undefined;
    }
    const key = readJsonObjectKey(raw, cursor);
    if (key === null) {
      return undefined;
    }
    if (!expectJsonChar(raw, cursor, ":")) {
      return undefined;
    }
    if (key === segment) {
      if (isLeaf) {
        skipJsonWhitespaceAndComments(raw, cursor);
        const valueOffset = cursor.pos;
        if (
          expectedValue !== undefined &&
          !valuesRoughlyMatch(peekJsonValueAt(raw, cursor), expectedValue)
        ) {
          return undefined;
        }
        return valueOffset;
      }
      return locateJsonPathValueOffsetAtCurrent(raw, cursor, segments, depth + 1, expectedValue);
    }
    skipJsonValue(raw, cursor);
    skipJsonWhitespaceAndComments(raw, cursor);
    if (raw[cursor.pos] === ",") {
      cursor.pos += 1;
      continue;
    }
    if (raw[cursor.pos] === "}") {
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function peekJsonValueAt(raw: string, cursor: JsonCursor): unknown {
  const probe: JsonCursor = { pos: cursor.pos };
  skipJsonWhitespaceAndComments(raw, probe);
  if (probe.pos >= raw.length) {
    return undefined;
  }
  const char = raw[probe.pos];
  if (char === '"' || char === "'") {
    return readJsonStringToken(raw, { pos: probe.pos }) ?? undefined;
  }
  const literalStart = probe.pos;
  skipJsonLiteral(raw, probe);
  const literal = raw.slice(literalStart, probe.pos).trim();
  if (literal === "true") {
    return true;
  }
  if (literal === "false") {
    return false;
  }
  if (literal === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(literal)) {
    return Number(literal);
  }
  if (literal.length > 0) {
    return literal;
  }
  return undefined;
}

/** Formats config issue path segments with bracket notation for array indexes. */
export function formatConfigIssuePath(segments: readonly ConfigIssuePathSegment[]): string {
  if (segments.length === 0) {
    return "";
  }
  let formatted = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }
    formatted = formatted ? `${formatted}.${segment}` : segment;
  }
  return formatted;
}

export function parseConfigIssuePath(
  pathValue: string,
  opts: { numericDotSegments?: boolean } = {},
): ConfigIssuePathSegment[] {
  const trimmed = pathValue.trim();
  if (!trimmed || trimmed === "<root>") {
    return [];
  }
  const segments: ConfigIssuePathSegment[] = [];
  let index = 0;
  while (index < trimmed.length) {
    if (trimmed[index] === ".") {
      index += 1;
      continue;
    }
    if (trimmed[index] === "[") {
      const close = trimmed.indexOf("]", index + 1);
      if (close === -1) {
        break;
      }
      const rawIndex = trimmed.slice(index + 1, close);
      const parsedIndex = Number(rawIndex);
      if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
        segments.push(parsedIndex);
      }
      index = close + 1;
      continue;
    }
    let end = index;
    while (end < trimmed.length && trimmed[end] !== "." && trimmed[end] !== "[") {
      end += 1;
    }
    const segment = trimmed.slice(index, end);
    if (segment) {
      const parsedIndex = Number(segment);
      if (opts.numericDotSegments && Number.isInteger(parsedIndex) && parsedIndex >= 0) {
        segments.push(parsedIndex);
      } else {
        segments.push(segment);
      }
    }
    index = end;
  }
  return segments;
}

function resolveConfigIssueSegments(root: unknown, pathValue: string): ConfigIssuePathSegment[] {
  const rawSegments = parseConfigIssuePath(pathValue);
  const segments: ConfigIssuePathSegment[] = [];
  let current: unknown = root;
  for (const rawSegment of rawSegments) {
    if (typeof rawSegment === "number") {
      segments.push(rawSegment);
      current = Array.isArray(current) ? current[rawSegment] : undefined;
      continue;
    }
    const parsedIndex = Number(rawSegment);
    const segment =
      Array.isArray(current) && Number.isInteger(parsedIndex) && parsedIndex >= 0
        ? parsedIndex
        : rawSegment;
    segments.push(segment);
    if (typeof segment === "number") {
      current = Array.isArray(current) ? current[segment] : undefined;
      continue;
    }
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return segments;
}

export function resolveConfigValueAtIssuePath(
  root: unknown,
  segments: readonly ConfigIssuePathSegment[],
): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function safeStringifyReceivedValue(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    if (serialized.length > 160) {
      return `${serialized.slice(0, 157)}...`;
    }
    return serialized;
  } catch {
    return null;
  }
}

function messageAlreadyIncludesReceivedValue(message: string, receivedLabel: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("got:")) {
    return true;
  }
  if (/\breceived\b/.test(lower)) {
    return true;
  }
  return lower.includes(receivedLabel.toLowerCase());
}

function shouldOmitReceivedValueHint(pathValue: string, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (isSecretRef(value)) {
    return true;
  }
  if (isSensitiveConfigPath(pathValue)) {
    return true;
  }
  if (typeof value === "object" && value !== null) {
    return true;
  }
  return safeStringifyReceivedValue(value) === null;
}

/** Appends a compact received-value hint when safe and not already present. */
export function appendReceivedValueHint(
  message: string,
  pathValue: string,
  value: unknown,
): string {
  if (shouldOmitReceivedValueHint(pathValue, value)) {
    return message;
  }
  const receivedLabel = safeStringifyReceivedValue(value);
  if (!receivedLabel || messageAlreadyIncludesReceivedValue(message, receivedLabel)) {
    return message;
  }
  return `${message}, got: ${receivedLabel}`;
}

/** Resolves a 1-based source line for an issue path within raw config text. */
export function resolveConfigIssueLineInRaw(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
  expectedValue?: unknown,
): number | undefined {
  const offset = locateJsonPathValueOffset(raw, segments, expectedValue);
  if (offset === undefined) {
    return undefined;
  }
  return lineNumberAtOffset(raw, offset);
}

export type AttachConfigIssueDiagnosticsParams = {
  raw: string | null | undefined;
  parsed: unknown;
  configPath?: string | null;
  formatPathForDisplay?: boolean;
  includeReceivedValueHint?: boolean;
};

export type ConfigIssueDiagnostics = ConfigValidationIssue & {
  line?: number;
  sourceFile?: string;
};

function rawMayUseConfigIncludes(raw: string | null): boolean {
  return raw !== null && /(?:^|[{,])\s*["']?\$include["']?\s*:/.test(raw);
}

export function attachConfigIssueDiagnostics(
  issues: readonly ConfigValidationIssue[],
  params: AttachConfigIssueDiagnosticsParams,
): ConfigIssueDiagnostics[] {
  const raw = typeof params.raw === "string" ? params.raw : null;
  const configBasename =
    typeof params.configPath === "string" && params.configPath.trim()
      ? path.basename(params.configPath)
      : "openclaw.json";

  const hasIncludeDirective = rawMayUseConfigIncludes(raw);

  return issues.map((issue) => {
    const segments = resolveConfigIssueSegments(params.parsed, issue.path);
    const receivedValue = resolveConfigValueAtIssuePath(params.parsed, segments);
    const line =
      raw === null || hasIncludeDirective
        ? undefined
        : resolveConfigIssueLineInRaw(raw, segments, receivedValue ?? undefined);
    const canUseMainSourceDiagnostics = line !== undefined;
    const message =
      params.includeReceivedValueHint && canUseMainSourceDiagnostics
        ? appendReceivedValueHint(issue.message, issue.path, receivedValue)
        : issue.message;
    return {
      ...issue,
      path: params.formatPathForDisplay ? formatConfigIssuePath(segments) : issue.path,
      message,
      ...(canUseMainSourceDiagnostics ? { line, sourceFile: configBasename } : {}),
    };
  });
}
