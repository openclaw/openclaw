import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { parseConfigPathArrayIndex } from "./path-array-index.js";

export type ConcreteConfigPathSegment = string | number;
export type ParsedConcreteConfigPath = {
  tokens: ConcreteConfigPathSegment[];
  quotedNumericSegments: ReadonlySet<number>;
};

function parseQuotedBracketPathSegment(value: string): unknown {
  const quote = value.startsWith('"') ? '"' : "'";
  if (!value.endsWith(quote)) {
    throw new SyntaxError("Unterminated quoted path segment");
  }

  // Retain the path grammar's control-character rejection and silent line separators.
  const normalized = value.replace(/\\(?:\r\n|[\s\S])|[\s\S]/g, (token, index: number) => {
    if (token.startsWith("\\")) {
      const escaped = token[1];
      if (escaped && escaped.charCodeAt(0) < 0x20 && escaped !== "\r" && escaped !== "\n") {
        throw new SyntaxError("Invalid escaped control character in path segment");
      }
      return token;
    }
    if (token === quote && index !== 0 && index !== value.length - 1) {
      throw new SyntaxError("Unexpected quote in path segment");
    }
    if (token.charCodeAt(0) < 0x20) {
      throw new SyntaxError("Unescaped control character in path segment");
    }
    return token === "\u2028" ? "\\u2028" : token === "\u2029" ? "\\u2029" : token;
  });
  return parseJsonWithJson5Fallback(normalized);
}

function parseBracketPathSegment(raw: string, fullPath: string): ConcreteConfigPathSegment {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid path (empty "[]"): ${fullPath}`);
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    try {
      const parsed = parseQuotedBracketPathSegment(trimmed);
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed;
      }
    } catch (err) {
      throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`, { cause: err });
    }
    throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`);
  }
  return parseConfigPathArrayIndex(trimmed) ?? trimmed;
}

function assertNotWhitespaceSegment(current: string, raw: string): void {
  if (current.length > 0 && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
}

function findBracketPathClose(path: string, open: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = open + 1; index < path.length; index += 1) {
    const character = path[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "]") {
      return index;
    }
    if ((character === '"' || character === "'") && !path.slice(open + 1, index).trim()) {
      quote = character;
    }
  }
  return -1;
}

/** Reads diagnostic path identity without applying object-mutation key restrictions. */
export function tokenizeConcreteConfigPath(raw: string): ParsedConcreteConfigPath {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Path is empty.");
  }
  const parts: ConcreteConfigPathSegment[] = [];
  const quotedNumericSegments = new Set<number>();
  let current = "";
  let segmentEmitted = false;
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === "\\") {
      const next = trimmed[index + 1];
      if (next === undefined) {
        throw new Error(`Invalid path (trailing escape): ${raw}`);
      }
      current += next;
      index += 2;
      continue;
    }
    if (character === ".") {
      assertNotWhitespaceSegment(current, raw);
      if (!segmentEmitted && !current.trim()) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current.trim());
      }
      current = "";
      segmentEmitted = false;
      index += 1;
      continue;
    }
    if (character === "[") {
      assertNotWhitespaceSegment(current, raw);
      if (!current.trim() && !segmentEmitted && parts.length > 0) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current.trim());
      }
      current = "";
      const close = findBracketPathClose(trimmed, index);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(index + 1, close).trim();
      const segment = parseBracketPathSegment(inside, raw);
      if (
        typeof segment === "string" &&
        (inside.startsWith('"') || inside.startsWith("'")) &&
        parseConfigPathArrayIndex(segment) !== undefined
      ) {
        quotedNumericSegments.add(parts.length);
      }
      parts.push(segment);
      const next = trimmed[close + 1];
      if (next !== undefined && next !== "." && next !== "[") {
        throw new Error(`Invalid path (missing separator after bracket): ${raw}`);
      }
      segmentEmitted = true;
      index = close + 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (!segmentEmitted && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
  if (current) {
    parts.push(current.trim());
  }
  return { tokens: parts, quotedNumericSegments };
}

/** Retains quoted numeric-key provenance while rejecting unsafe object-key segments. */
export function parseConcreteConfigPathWithProvenance(raw: string): ParsedConcreteConfigPath {
  const parsed = tokenizeConcreteConfigPath(raw);
  for (const segment of parsed.tokens) {
    if (typeof segment === "string" && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
  return parsed;
}

/** Parses one concrete path while keeping explicit array brackets distinct from quoted keys. */
export function parseConcreteConfigPathTokens(raw: string): ConcreteConfigPathSegment[] {
  return parseConcreteConfigPathWithProvenance(raw).tokens;
}

/** Parses one concrete config path into the existing string-segment CLI contract. */
export function parseConcreteConfigPath(raw: string): string[] {
  return parseConcreteConfigPathTokens(raw).map(String);
}

/** Appends one config path segment without confusing literal record keys with traversal. */
export function appendConfigPathSegment(path: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${path}[${segment}]`;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(segment)) {
    return `${path}[${JSON.stringify(segment)}]`;
  }
  return path ? `${path}.${segment}` : segment;
}

/** Formats concrete tokens, recovering array indices from their actual source containers. */
export function formatConcreteConfigPath(
  segments: readonly ConcreteConfigPathSegment[],
  source?: unknown,
): string {
  let cursor = source;
  return segments.reduce<string>((path, segment) => {
    const concreteSegment =
      typeof segment === "string" && Array.isArray(cursor)
        ? (parseConfigPathArrayIndex(segment) ?? segment)
        : segment;
    cursor =
      cursor !== null && typeof cursor === "object"
        ? Reflect.get(cursor, String(segment))
        : undefined;
    return appendConfigPathSegment(path, concreteSegment);
  }, "");
}

/** Reads object paths, optionally restricting array keys to canonical config indexes. */
export function readObjectPath(
  root: unknown,
  path: readonly string[],
  arrayMode: "raw" | "canonical" | "bounded" = "raw",
): unknown {
  let current: unknown = root;
  for (const key of path) {
    const parent = asOptionalObjectRecord(current);
    if (!parent) {
      return undefined;
    }
    if (arrayMode !== "raw" && Array.isArray(parent)) {
      const index = parseConfigPathArrayIndex(key);
      if (index === undefined || (arrayMode === "bounded" && index >= parent.length)) {
        return undefined;
      }
    }
    current = parent[key];
  }
  return current;
}

/** Joins path segments into their dotted-path representation. */
export function toDotPath(segments: readonly string[]): string {
  return segments.join(".");
}
