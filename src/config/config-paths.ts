import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isPlainObject } from "../utils.js";
import { normalizeConfigModelSelectionParent } from "./model-input-normalization.js";

type PathNode = Record<string, unknown>;

function setOwnConfigProperty(node: PathNode, key: string, value: unknown): void {
  if (Object.hasOwn(node, key)) {
    node[key] = value;
    return;
  }
  Object.defineProperty(node, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Parses CLI/config dot-notation paths and rejects unsafe object-key segments. */
export function parseConfigPath(
  raw: string,
): { ok: true; path: string[] } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const parts = trimmed.split(".").map((part) => part.trim());
  if (parts.some((part) => !part)) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  // These helpers mutate plain objects; block prototype-bearing keys before any setter can create
  // or traverse them.
  if (parts.some((part) => isBlockedObjectKey(part))) {
    return { ok: false, error: "Invalid path segment." };
  }
  return { ok: true, path: parts };
}

export function setConfigValueAtPath(root: PathNode, path: string[], value: unknown): void {
  const leafKey = path.at(-1);
  if (leafKey === undefined) {
    throw new Error("Config path must contain at least one segment");
  }
  let cursor: PathNode = root;
  for (const [index, key] of path.slice(0, -1).entries()) {
    const existing = Object.hasOwn(cursor, key) ? cursor[key] : undefined;
    const next: PathNode = isPlainObject(existing)
      ? existing
      : (normalizeConfigModelSelectionParent(existing, path, index) ?? {});
    if (next !== existing) {
      setOwnConfigProperty(cursor, key, next);
    }
    cursor = next;
  }
  setOwnConfigProperty(cursor, leafKey, value);
}

/** Removes a value at a config path and prunes empty parent objects created by setters. */
export function unsetConfigValueAtPath(
  root: PathNode,
  path: string[],
  preserveEmptyParentsFrom?: PathNode,
): boolean {
  const leafKey = path.at(-1);
  if (leafKey === undefined) {
    return false;
  }
  const stack: Array<{ node: PathNode; key: string }> = [];
  let cursor: PathNode = root;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(cursor, key)) {
      return false;
    }
    const next = cursor[key];
    if (!isPlainObject(next)) {
      return false;
    }
    stack.push({ node: cursor, key });
    cursor = next;
  }
  if (!Object.hasOwn(cursor, leafKey)) {
    return false;
  }
  delete cursor[leafKey];
  // Keep config writes tidy: removing foo.bar should also remove foo when it became empty, while
  // preserving any parent that still carries sibling config.
  for (const { node, key } of stack.toReversed()) {
    const child = node[key];
    if (
      isPlainObject(child) &&
      Object.keys(child).length === 0 &&
      (!preserveEmptyParentsFrom ||
        getConfigValueAtPath(preserveEmptyParentsFrom, path.slice(0, stack.length)) === undefined)
    ) {
      delete node[key];
      stack.pop();
    } else {
      break;
    }
  }
  return true;
}

export function getConfigValueAtPath(root: PathNode, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}
