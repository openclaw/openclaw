import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PathNode = Record<string, unknown>;

/**
 * Parse a config path supporting both dot notation and bracket notation.
 * - "foo.bar" → ["foo", "bar"]
 * - "foo.bar.baz" → ["foo", "bar", "baz"]
 * - 'foo["bar.baz"].qux' → ["foo", "bar.baz", "qux"]
 * - "foo['bar'].baz" → ["foo", "bar", "baz"]
 * - "providers.llama\\.cpp.baseUrl" → ["providers", "llama.cpp", "baseUrl"]
 */
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

  // Parse using a simple state machine that handles bracket notation
  const parts: string[] = [];
  let current = "";
  let inBracket = false;
  let bracketType: "'" | '"' | null = null;
  let i = 0;

  while (i < trimmed.length) {
    const char = trimmed[i];

    if (inBracket) {
      // Inside brackets - look for closing bracket
      if (char === "\\" && i + 1 < trimmed.length) {
        // Handle escaped characters inside brackets
        const nextChar = trimmed[i + 1];
        if (nextChar === "." || nextChar === bracketType) {
          // Escaped dot or escaped quote
          current += nextChar;
        } else {
          // Keep the backslash for other escape sequences
          current += char;
          current += nextChar;
        }
        i += 2;
        continue;
      }
      if (char === bracketType) {
        // Check if next char is also closing bracket (escaped quote)
        if (i + 1 < trimmed.length && trimmed[i + 1] === bracketType) {
          // Double bracket - treat as escaped bracket
          current += char;
          i += 2;
          continue;
        }
        // Closing bracket - end of this segment
        if (!current) {
          // Empty bracket content - reject
          return {
            ok: false,
            error: "Invalid path. Use dot notation (e.g. foo.bar).",
          };
        }
        parts.push(current);
        current = "";
        inBracket = false;
        bracketType = null;
        i++;
        // Skip trailing dot after closing bracket (e.g., foo["bar"].baz)
        if (i < trimmed.length && trimmed[i] === ".") {
          i++;
        }
        continue;
      }
      current += char;
      i++;
      continue;
    }

    // Not in brackets
    if (char === "[") {
      // Start of bracket notation
      if (current) {
        // Push the current segment (with escaped dots resolved)
        parts.push(current.replace(/\\\./g, "."));
        current = "";
      }
      // Check bracket type
      if (i + 1 < trimmed.length && (trimmed[i + 1] === "'" || trimmed[i + 1] === '"')) {
        bracketType = trimmed[i + 1] as "'" | '"';
        inBracket = true;
        i += 2;
        continue;
      }
      // Numeric bracket like [0] - treat as part of path
      current += char;
      i++;
      continue;
    }

    // Unmatched closing bracket - reject
    if (char === "]") {
      return {
        ok: false,
        error: "Invalid path. Use dot notation (e.g. foo.bar).",
      };
    }

    if (char === ".") {
      // Dot separator
      if (current) {
        // Push the current segment (with escaped dots resolved)
        parts.push(current.replace(/\\\./g, "."));
        current = "";
      }
      i++;
      continue;
    }

    if (char === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === ".") {
      // Escaped dot - include literal dot in current segment
      current += ".";
      i += 2;
      continue;
    }

    current += char;
    i++;
  }

  // Handle remaining current segment
  if (current) {
    parts.push(current.replace(/\\\./g, "."));
  }

  // Check for unclosed brackets
  if (inBracket) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  if (parts.some((part) => !part)) {
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
