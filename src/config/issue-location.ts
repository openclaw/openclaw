// JSON5-aware config issue path navigator and display enrichment.
// Walks raw config text to resolve line numbers and received values
// for config validation issues, without a full parser.
import path from "node:path";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { ConfigValidationIssue } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

export type ConfigIssuePathSegment = string | number;

// ---------------------------------------------------------------------------
// JSON5 text navigator
// ---------------------------------------------------------------------------

type Cursor = { pos: number };

function lineAtOffset(raw: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < raw.length; i++) {
    if (raw[i] === "\n") line++;
  }
  return line;
}

/** Skip whitespace and JSON5 comments. */
function skipWS(raw: string, c: Cursor): void {
  while (c.pos < raw.length) {
    const ch = raw[c.pos];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      c.pos++;
      continue;
    }
    if (ch === "/" && raw[c.pos + 1] === "/") {
      c.pos += 2;
      while (c.pos < raw.length && raw[c.pos] !== "\n") c.pos++;
      continue;
    }
    if (ch === "/" && raw[c.pos + 1] === "*") {
      c.pos += 2;
      while (c.pos < raw.length - 1) {
        if (raw[c.pos] === "*" && raw[c.pos + 1] === "/") {
          c.pos += 2;
          break;
        }
        c.pos++;
      }
      continue;
    }
    break;
  }
}

/** Skip a JSON5 string (single or double quoted). */
function skipStr(raw: string, c: Cursor): void {
  const quote = raw[c.pos];
  c.pos++;
  while (c.pos < raw.length) {
    const ch = raw[c.pos];
    if (ch === "\\") {
      c.pos += 2;
    } else if (ch === quote) {
      c.pos++;
      return;
    } else {
      c.pos++;
    }
  }
}

/** Skip a JSON5 value (string, number, boolean, null, object, array). */
function skipVal(raw: string, c: Cursor): void {
  skipWS(raw, c);
  if (c.pos >= raw.length) return;
  const ch = raw[c.pos];
  if (ch === '"' || ch === "'") {
    skipStr(raw, c);
  } else if (ch === "{" || ch === "[") {
    skipComposite(raw, c);
  } else {
    while (c.pos < raw.length) {
      const ch2 = raw[c.pos];
      if (ch2 === "," || ch2 === "}" || ch2 === "]" || ch2 === "/" || ch2 === " " || ch2 === "\t" || ch2 === "\r" || ch2 === "\n") return;
      c.pos++;
    }
  }
}

/** Skip a composite value (object or array), correctly tracking nesting. */
function skipComposite(raw: string, c: Cursor): void {
  const open = raw[c.pos];
  const close = open === "{" ? "}" : "]";
  let depth = 1;
  c.pos++;
  while (c.pos < raw.length && depth > 0) {
    const ch = raw[c.pos];
    if (ch === '"' || ch === "'") {
      skipStr(raw, c);
    } else if (ch === "\\") {
      c.pos += 2;
    } else if (ch === open) {
      depth++;
      c.pos++;
    } else if (ch === close) {
      depth--;
      c.pos++;
    } else if (ch === "/" && raw[c.pos + 1] === "/") {
      c.pos += 2;
      while (c.pos < raw.length && raw[c.pos] !== "\n") c.pos++;
    } else if (ch === "/" && raw[c.pos + 1] === "*") {
      c.pos += 2;
      while (c.pos < raw.length - 1) {
        if (raw[c.pos] === "*" && raw[c.pos + 1] === "/") {
          c.pos += 2;
          break;
        }
        c.pos++;
      }
    } else {
      c.pos++;
    }
  }
}

/** Read a JSON5 string value (single or double quoted). */
function readStr(raw: string, c: Cursor): string | null {
  skipWS(raw, c);
  const quote = raw[c.pos];
  if (quote !== '"' && quote !== "'") return null;
  c.pos++;
  let value = "";
  while (c.pos < raw.length) {
    const ch = raw[c.pos];
    if (ch === "\\") {
      const next = raw[c.pos + 1];
      if (next !== undefined) value += next;
      c.pos += 2;
    } else if (ch === quote) {
      c.pos++;
      return value;
    } else {
      value += ch;
      c.pos++;
    }
  }
  return null;
}

/** Read a JSON5 object key (quoted string or unquoted identifier). */
function readKey(raw: string, c: Cursor): string | null {
  skipWS(raw, c);
  const ch = raw[c.pos];
  if (ch === '"' || ch === "'") return readStr(raw, c);
  if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
    const start = c.pos;
    c.pos++;
    while (c.pos < raw.length && /[A-Za-z0-9_$]/.test(raw[c.pos] ?? "")) c.pos++;
    return raw.slice(start, c.pos);
  }
  return null;
}

/** Expect and consume a specific character (skipping whitespace). */
function expect(raw: string, c: Cursor, ch: string): boolean {
  skipWS(raw, c);
  if (raw[c.pos] !== ch) return false;
  c.pos++;
  return true;
}

/**
 * Navigate raw JSON5 text to find the byte offset of a value at the given path.
 * Returns undefined when the path cannot be resolved.
 */
function navigateToOffset(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
): number | undefined {
  if (segments.length === 0 || raw.trim().length === 0) return undefined;
  const c: Cursor = { pos: 0 };
  skipWS(raw, c);
  return navigateAt(raw, c, segments, 0);
}

function navigateAt(
  raw: string,
  c: Cursor,
  segments: readonly ConfigIssuePathSegment[],
  depth: number,
): number | undefined {
  const segment = segments[depth];
  const isLeaf = depth === segments.length - 1;

  if (typeof segment === "number") {
    if (!expect(raw, c, "[")) return undefined;
    for (let i = 0; i < segment; i++) {
      skipVal(raw, c);
      if (!expect(raw, c, ",")) return undefined;
    }
    if (isLeaf) {
      skipWS(raw, c);
      return c.pos;
    }
    return navigateAt(raw, c, segments, depth + 1);
  }

  if (!expect(raw, c, "{")) return undefined;
  while (c.pos < raw.length) {
    skipWS(raw, c);
    if (raw[c.pos] === "}") return undefined;
    const key = readKey(raw, c);
    if (key === null) return undefined;
    if (!expect(raw, c, ":")) return undefined;
    if (key === segment) {
      if (isLeaf) {
        skipWS(raw, c);
        return c.pos;
      }
      return navigateAt(raw, c, segments, depth + 1);
    }
    skipVal(raw, c);
    skipWS(raw, c);
    if (raw[c.pos] === ",") {
      c.pos++;
      continue;
    }
    if (raw[c.pos] === "}") return undefined;
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path formatting
// ---------------------------------------------------------------------------

/** Format config issue path segments with bracket notation for array indexes. */
export function formatConfigIssuePath(segments: readonly ConfigIssuePathSegment[]): string {
  if (segments.length === 0) return "";
  let out = "";
  for (const s of segments) {
    if (typeof s === "number") {
      out += `[${s}]`;
    } else {
      out = out ? `${out}.${s}` : s;
    }
  }
  return out;
}

/**
 * Parse a display-formatted issue path back into traversal segments.
 * Supports both bracket notation (`agents.list[3]`) and legacy dot-notation
 * (`agents.list.3` with numericDotSegments option).
 */
export function parseConfigIssuePath(
  pathValue: string,
  opts?: { numericDotSegments?: boolean },
): ConfigIssuePathSegment[] {
  const trimmed = pathValue.trim();
  if (!trimmed || trimmed === "<root>") return [];
  const segments: ConfigIssuePathSegment[] = [];
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === ".") {
      i++;
      continue;
    }
    if (trimmed[i] === "[") {
      const close = trimmed.indexOf("]", i + 1);
      if (close === -1) break;
      const n = Number(trimmed.slice(i + 1, close));
      if (Number.isInteger(n) && n >= 0) segments.push(n);
      i = close + 1;
      continue;
    }
    let end = i;
    while (end < trimmed.length && trimmed[end] !== "." && trimmed[end] !== "[") end++;
    const seg = trimmed.slice(i, end);
    if (seg) {
      const n = Number(seg);
      if (opts?.numericDotSegments && Number.isInteger(n) && n >= 0) {
        segments.push(n);
      } else {
        segments.push(seg);
      }
    }
    i = end;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Value resolution from parsed config
// ---------------------------------------------------------------------------

/** Resolve the actual value at a path in the parsed config object. */
export function resolveConfigValueAtPath(
  root: unknown,
  segments: readonly ConfigIssuePathSegment[],
): unknown {
  let current: unknown = root;
  for (const s of segments) {
    if (typeof s === "number") {
      if (!Array.isArray(current) || s < 0 || s >= current.length) return undefined;
      current = current[s];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current))
        return undefined;
      current = (current as Record<string, unknown>)[s];
    }
  }
  return current;
}

/**
 * Resolve raw path segments against the parsed config to distinguish array
 * indices from numeric record keys. A numeric segment is treated as an array
 * index only when the parent value is actually an array.
 */
function resolveSegmentsAgainstParsed(
  root: unknown,
  rawSegments: readonly ConfigIssuePathSegment[],
): ConfigIssuePathSegment[] {
  const resolved: ConfigIssuePathSegment[] = [];
  let current: unknown = root;
  for (const s of rawSegments) {
    if (typeof s === "number") {
      if (Array.isArray(current)) {
        resolved.push(s);
        current = current[s];
      } else {
        const key = String(s);
        resolved.push(key);
        current =
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined;
      }
    } else {
      resolved.push(s);
      current =
        current && typeof current === "object" && !Array.isArray(current)
          ? (current as Record<string, unknown>)[s]
          : undefined;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Received value hint
// ---------------------------------------------------------------------------

function safeStringify(v: unknown): string | null {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  } catch {
    return null;
  }
}

function messageAlreadyHasReceived(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("got:") || /\breceived\b/.test(lower);
}

function shouldOmitReceivedValue(pathValue: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (isSecretRef(value)) return true;
  if (isSensitiveConfigPath(pathValue)) return true;
  if (typeof value === "object" && value !== null) return true;
  return safeStringify(value) === null;
}

/** Append a compact `got: <value>` hint when safe and not already present. */
export function appendReceivedValueHint(
  message: string,
  pathValue: string,
  value: unknown,
): string {
  if (shouldOmitReceivedValue(pathValue, value)) return message;
  const label = safeStringify(value);
  if (!label || messageAlreadyHasReceived(message)) return message;
  return `${message}, got: ${label}`;
}

// ---------------------------------------------------------------------------
// Line number resolution
// ---------------------------------------------------------------------------

/** Resolve the 1-based source line number for a value at the given path. */
export function resolveConfigIssueLineInRaw(
  raw: string,
  segments: readonly ConfigIssuePathSegment[],
): number | undefined {
  const offset = navigateToOffset(raw, segments);
  if (offset === undefined) return undefined;
  return lineAtOffset(raw, offset);
}

// ---------------------------------------------------------------------------
// Issue enrichment
// ---------------------------------------------------------------------------

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

/**
 * Enrich config validation issues with display-friendly diagnostics:
 * - Bracket notation for array indices (when formatPathForDisplay is true)
 * - Received value hints (when includeReceivedValueHint is true)
 * - Source line numbers and file name
 *
 * Line numbers and received values are only attached when the value can be
 * resolved in the raw config text. Paths in $include'd files gracefully
 * degrade — the navigator won't find them in the raw text, so no line
 * number or received value is shown for those issues.
 */
export function attachConfigIssueDiagnostics(
  issues: readonly ConfigValidationIssue[],
  params: AttachConfigIssueDiagnosticsParams,
): ConfigIssueDiagnostics[] {
  const raw = typeof params.raw === "string" ? params.raw : null;
  const configBasename =
    typeof params.configPath === "string" && params.configPath.trim()
      ? path.basename(params.configPath)
      : "openclaw.json";

  return issues.map((issue) => {
    const rawSegments = parseConfigIssuePath(issue.path, { numericDotSegments: true });
    // Resolve segments against the parsed config to distinguish array indices
    // from numeric record keys (e.g., plugins.entries.123 is a string key, not
    // an array index).
    const segments = resolveSegmentsAgainstParsed(params.parsed, rawSegments);
    const receivedValue = resolveConfigValueAtPath(params.parsed, segments);
    const line = raw === null ? undefined : resolveConfigIssueLineInRaw(raw, segments);
    const canResolve = line !== undefined;

    const message =
      params.includeReceivedValueHint && canResolve
        ? appendReceivedValueHint(issue.message, issue.path, receivedValue)
        : issue.message;

    return {
      ...issue,
      path: params.formatPathForDisplay ? formatConfigIssuePath(segments) : issue.path,
      message,
      ...(canResolve ? { line, sourceFile: configBasename } : {}),
    };
  });
}
