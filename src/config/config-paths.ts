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

  // Parse path with support for bracket notation: foo["bar.baz"] or foo['bar.baz'] or foo[key]
  // Strategy: Tokenize by bracket groups first, then split remaining by dots
  const parts: string[] = [];
  let remaining = trimmed;

  // Keep extracting bracket-notation segments until none left
  while (remaining.length > 0) {
    // Check if we start with a bracket group: ["..."] or ['...'] or [...]
    const bracketMatch = remaining.match(/^\[("([^"]+)"|'([^']+)'|([^\]]+))\]/);

    if (bracketMatch) {
      // Extract the key from inside brackets
      const key = bracketMatch[2] || bracketMatch[3] || bracketMatch[4];
      if (key !== undefined) {
        parts.push(key);
      }
      // Move past the bracket group
      remaining = remaining.slice(bracketMatch[0].length);

      // If there's a dot after, skip it
      if (remaining.startsWith(".")) {
        remaining = remaining.slice(1);
      }
    } else {
      // No bracket at start - find next dot or bracket
      const dotIndex = remaining.indexOf(".");
      const bracketIndex = remaining.indexOf("[");

      if (dotIndex === -1 && bracketIndex === -1) {
        // No more separators - rest is a key
        if (remaining) {
          parts.push(remaining);
        }
        break;
      } else if (bracketIndex !== -1 && (dotIndex === -1 || bracketIndex < dotIndex)) {
        // Next bracket comes before dot - extract up to bracket
        const key = remaining.slice(0, bracketIndex);
        if (key) {
          parts.push(key);
        }
        remaining = remaining.slice(bracketIndex);
      } else if (dotIndex !== -1 && (bracketIndex === -1 || dotIndex < bracketIndex)) {
        // Next dot comes before bracket - extract up to dot
        const key = remaining.slice(0, dotIndex);
        if (key) {
          parts.push(key);
        }
        remaining = remaining.slice(dotIndex + 1);
      }
    }
  }

  if (parts.length === 0) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  // Filter empty parts
  const filteredParts = parts.filter((p) => p !== "");

  if (filteredParts.some((part) => isBlockedObjectKey(part))) {
    return { ok: false, error: "Invalid path segment." };
  }

  return { ok: true, path: filteredParts };
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
