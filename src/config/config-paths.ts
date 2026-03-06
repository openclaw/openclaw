import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PathNode = Record<string, unknown>;

const INVALID_PATH_ERROR =
  'Invalid path. Use dot or bracket notation (e.g. foo.bar or foo["bar.baz"]).';

type ParsedPathResult =
  | {
      ok: true;
      path: string[];
    }
  | {
      ok: false;
      error: string;
    };

function parseQuotedBracketSegment(
  raw: string,
  start: number,
): ParsedPathResult & { next?: number } {
  let cursor = start;
  while (cursor < raw.length && /\s/.test(raw[cursor])) {
    cursor += 1;
  }
  if (cursor >= raw.length) {
    return { ok: false, error: INVALID_PATH_ERROR };
  }

  const quote = raw[cursor];
  if (quote !== `"` && quote !== `'`) {
    const close = raw.indexOf("]", cursor);
    if (close === -1) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }
    const value = raw.slice(cursor, close).trim();
    if (!value) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }
    return { ok: true, path: [value], next: close + 1 };
  }

  cursor += 1;
  let value = "";
  while (cursor < raw.length) {
    const ch = raw[cursor];
    if (ch === "\\") {
      const next = raw[cursor + 1];
      if (!next) {
        return { ok: false, error: INVALID_PATH_ERROR };
      }
      value += next;
      cursor += 2;
      continue;
    }
    if (ch === quote) {
      cursor += 1;
      while (cursor < raw.length && /\s/.test(raw[cursor])) {
        cursor += 1;
      }
      if (raw[cursor] !== "]") {
        return { ok: false, error: INVALID_PATH_ERROR };
      }
      if (!value.trim()) {
        return { ok: false, error: INVALID_PATH_ERROR };
      }
      return { ok: true, path: [value], next: cursor + 1 };
    }
    value += ch;
    cursor += 1;
  }
  return { ok: false, error: INVALID_PATH_ERROR };
}

export function splitConfigPath(raw: string): ParsedPathResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: INVALID_PATH_ERROR,
    };
  }

  const parts: string[] = [];
  let current = "";
  let cursor = 0;
  let expectSegment = true;

  const pushCurrent = (): boolean => {
    const segment = current.trim();
    current = "";
    if (!segment) {
      return false;
    }
    parts.push(segment);
    return true;
  };

  while (cursor < trimmed.length) {
    const ch = trimmed[cursor];

    if (/\s/.test(ch) && !current) {
      cursor += 1;
      continue;
    }

    if (ch === "\\") {
      const next = trimmed[cursor + 1];
      if (!next) {
        return { ok: false, error: INVALID_PATH_ERROR };
      }
      current += next;
      expectSegment = false;
      cursor += 2;
      continue;
    }

    if (ch === ".") {
      if (current) {
        if (!pushCurrent()) {
          return { ok: false, error: INVALID_PATH_ERROR };
        }
        expectSegment = true;
        cursor += 1;
        continue;
      }
      if (!expectSegment) {
        expectSegment = true;
        cursor += 1;
        continue;
      }
      return { ok: false, error: INVALID_PATH_ERROR };
    }

    if (ch === "[") {
      if (current && !pushCurrent()) {
        return { ok: false, error: INVALID_PATH_ERROR };
      }
      const bracket = parseQuotedBracketSegment(trimmed, cursor + 1);
      if (!bracket.ok || bracket.next == null) {
        return bracket;
      }
      parts.push(bracket.path[0]);
      expectSegment = false;
      cursor = bracket.next;
      continue;
    }

    if (!current && !expectSegment) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }

    current += ch;
    expectSegment = false;
    cursor += 1;
  }

  if (current) {
    if (!pushCurrent()) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }
  } else if (expectSegment) {
    return { ok: false, error: INVALID_PATH_ERROR };
  }

  if (parts.length === 0) {
    return { ok: false, error: INVALID_PATH_ERROR };
  }

  return { ok: true, path: parts };
}

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: string[];
  error?: string;
} {
  const parsed = splitConfigPath(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const parts = parsed.path;
  if (parts.some((part) => isBlockedObjectKey(part))) {
    return { ok: false, error: "Invalid path segment." };
  }
  return { ok: true, path: parts };
}

export function setConfigValueAtPath(root: PathNode, path: string[], value: unknown): void {
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    if (!isPlainObject(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as PathNode;
  }
  cursor[path[path.length - 1]] = value;
}

export function unsetConfigValueAtPath(root: PathNode, path: string[]): boolean {
  const stack: Array<{ node: PathNode; key: string }> = [];
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    if (!isPlainObject(next)) {
      return false;
    }
    stack.push({ node: cursor, key });
    cursor = next;
  }
  const leafKey = path[path.length - 1];
  if (!(leafKey in cursor)) {
    return false;
  }
  delete cursor[leafKey];
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = node[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete node[key];
    } else {
      break;
    }
  }
  return true;
}

export function getConfigValueAtPath(root: PathNode, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}
