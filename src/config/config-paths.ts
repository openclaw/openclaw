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

  const parts: string[] = [];
  let idx = 0;

  while (idx < trimmed.length) {
    const char = trimmed[idx];

    if (char === ".") {
      idx += 1;
      if (idx >= trimmed.length) {
        return {
          ok: false,
          error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
      }
      continue;
    }

    if (char === "[") {
      const quote = trimmed[idx + 1];
      if (quote !== '"' && quote !== "'") {
        return {
          ok: false,
          error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
      }
      const closeQuoteIdx = trimmed.indexOf(quote, idx + 2);
      const closeBracketIdx = closeQuoteIdx >= 0 ? trimmed.indexOf("]", closeQuoteIdx + 1) : -1;
      if (closeQuoteIdx < 0 || closeBracketIdx !== closeQuoteIdx + 1) {
        return {
          ok: false,
          error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
      }
      const key = trimmed.slice(idx + 2, closeQuoteIdx).trim();
      if (!key) {
        return {
          ok: false,
          error: "Invalid path. Use dot notation (e.g. foo.bar).",
        };
      }
      parts.push(key);
      idx = closeBracketIdx + 1;
      continue;
    }

    const nextDotIdx = trimmed.indexOf(".", idx);
    const nextBracketIdx = trimmed.indexOf("[", idx);
    const endIdx = [nextDotIdx, nextBracketIdx]
      .filter((value) => value >= 0)
      .reduce((min, value) => Math.min(min, value), trimmed.length);

    const key = trimmed.slice(idx, endIdx).trim();
    if (!key) {
      return {
        ok: false,
        error: "Invalid path. Use dot notation (e.g. foo.bar).",
      };
    }
    parts.push(key);
    idx = endIdx;
  }

  if (parts.length === 0 || parts.some((part) => !part)) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
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
