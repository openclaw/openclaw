import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PathNode = Record<string, unknown>;
export type PathSegment = string | number;

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: PathSegment[];
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  const segments: PathSegment[] = [];
  const parts = trimmed.split(".");
  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      return {
        ok: false,
        error: "Invalid path. Use dot notation (e.g. foo.bar).",
      };
    }

    // Parse array index syntax: key[index] or key[0]
    const arrayMatch = trimmedPart.match(/^([^[\]]+)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const index = parseInt(arrayMatch[2], 10);
      if (isBlockedObjectKey(key)) {
        return { ok: false, error: "Invalid path segment." };
      }
      segments.push(key, index);
    } else if (trimmedPart.includes("[") || trimmedPart.includes("]")) {
      // Reject malformed array index syntax (e.g., "key[1" or "key[abc]")
      return {
        ok: false,
        error:
          "Invalid path. Array index syntax requires numeric index in brackets (e.g. foo.bar[0]).",
      };
    } else {
      if (isBlockedObjectKey(trimmedPart)) {
        return { ok: false, error: "Invalid path segment." };
      }
      segments.push(trimmedPart);
    }
  }

  return { ok: true, path: segments };
}

export function setConfigValueAtPath(root: PathNode, path: PathSegment[], value: unknown): void {
  let cursor: unknown = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const segment = path[idx];
    const nextSegment = path[idx + 1];

    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) {
        return;
      }
      cursor = cursor[segment];
    } else {
      const next = (cursor as PathNode)[segment];
      // Determine if the next container should be an array or object
      if (typeof nextSegment === "number") {
        if (!Array.isArray(next)) {
          (cursor as PathNode)[segment] = [];
        }
      } else if (!isPlainObject(next)) {
        (cursor as PathNode)[segment] = {};
      }
      cursor = (cursor as PathNode)[segment];
    }
  }

  const lastSegment = path[path.length - 1];
  if (typeof lastSegment === "number") {
    if (Array.isArray(cursor)) {
      cursor[lastSegment] = value;
    }
  } else {
    (cursor as PathNode)[lastSegment] = value;
  }
}

export function unsetConfigValueAtPath(root: PathNode, path: PathSegment[]): boolean {
  if (path.length === 0) {
    return false;
  }

  // Navigate to the parent of the target, tracking the path
  const stack: Array<{ node: unknown; segment: PathSegment }> = [];
  let cursor: unknown = root;

  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const segment = path[idx];
    stack.push({ node: cursor, segment });

    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || segment >= cursor.length) {
        return false;
      }
      cursor = cursor[segment];
    } else {
      if (!isPlainObject(cursor) || !(segment in cursor)) {
        return false;
      }
      cursor = (cursor as PathNode)[segment];
    }
  }

  const lastSegment = path[path.length - 1];

  // Remove the target element
  if (typeof lastSegment === "number") {
    if (!Array.isArray(cursor) || lastSegment >= cursor.length) {
      return false;
    }
    cursor.splice(lastSegment, 1);
  } else {
    if (!isPlainObject(cursor) || !(lastSegment in cursor)) {
      return false;
    }
    delete (cursor as PathNode)[lastSegment];
  }

  // Clean up empty containers along the path (only for object keys, not array indices)
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, segment } = stack[idx];
    if (typeof segment === "number") {
      // Skip array indices in cleanup - arrays are preserved even when empty
      continue;
    }
    const child = (node as PathNode)[segment];
    // Only delete empty objects, not empty arrays (arrays may legitimately be empty after splice)
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete (node as PathNode)[segment];
    } else {
      break;
    }
  }

  return true;
}

export function getConfigValueAtPath(root: PathNode, path: PathSegment[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || segment >= cursor.length) {
        return undefined;
      }
      cursor = cursor[segment];
    } else {
      if (!isPlainObject(cursor)) {
        return undefined;
      }
      cursor = (cursor as PathNode)[segment];
    }
  }
  return cursor;
}
