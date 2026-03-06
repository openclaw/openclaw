import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PathNode = Record<string, unknown>;

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: string[];
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  // Reject obvious leading/trailing dot separators up front.
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  const INVALID_PATH_ERROR = {
    ok: false,
    error: "Invalid path. Use dot notation (e.g. foo.bar).",
  } as const;

  // State-machine parser supporting both plain dot notation (foo.bar) and
  // bracket notation (foo["bar.baz"]) so keys that contain dots (e.g. a
  // provider named "llama.cpp") are treated as a single path segment.
  const parts: string[] = [];
  let current = "";
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i];

    if (ch === "[") {
      // Bracket notation: key["segment.with.dots"] or ["key"]
      // Push any accumulated plain-text segment first.
      if (current) {
        parts.push(current);
        current = "";
      }
      i += 1;
      const quote = trimmed[i];
      if (quote !== '"' && quote !== "'") {
        return INVALID_PATH_ERROR;
      }
      i += 1;
      let key = "";
      while (i < trimmed.length && trimmed[i] !== quote) {
        // Allow backslash-escaped characters inside the bracket key.
        if (trimmed[i] === "\\") {
          i += 1;
          if (i < trimmed.length) {
            key += trimmed[i];
            i += 1;
          }
        } else {
          key += trimmed[i];
          i += 1;
        }
      }
      if (i >= trimmed.length) {
        // Unclosed quote.
        return INVALID_PATH_ERROR;
      }
      i += 1; // skip closing quote
      if (i >= trimmed.length || trimmed[i] !== "]") {
        return INVALID_PATH_ERROR;
      }
      i += 1; // skip ]
      if (!key) {
        // Empty bracket key is not allowed.
        return INVALID_PATH_ERROR;
      }
      parts.push(key);
      // After ], optionally consume a separating dot before the next segment.
      if (i < trimmed.length && trimmed[i] === ".") {
        i += 1;
        // A dot at the very end (or followed immediately by another dot) is invalid.
        if (i >= trimmed.length || trimmed[i] === ".") {
          return INVALID_PATH_ERROR;
        }
      }
    } else if (ch === ".") {
      // Dot separator: push the current accumulated segment.
      if (!current) {
        // Consecutive dots, or a leading dot that slipped past the pre-check.
        return INVALID_PATH_ERROR;
      }
      parts.push(current);
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }

  if (current) {
    parts.push(current);
  }

  if (parts.length === 0 || parts.some((part) => !part)) {
    return INVALID_PATH_ERROR;
  }
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
