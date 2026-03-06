import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PathNode = Record<string, unknown>;
type PathSegment = string | number;
type Path = PathSegment[];
type PathContainer = PathNode | unknown[];

function isPathContainer(value: unknown): value is PathContainer {
  return isPlainObject(value) || Array.isArray(value);
}

function getAt(container: PathContainer, key: PathSegment): unknown {
  if (Array.isArray(container) && typeof key === "number") {
    return container[key];
  }
  return (container as PathNode)[String(key)];
}

function setAt(container: PathContainer, key: PathSegment, value: unknown): void {
  if (Array.isArray(container) && typeof key === "number") {
    container[key] = value;
    return;
  }
  (container as PathNode)[String(key)] = value;
}

function hasAt(container: PathContainer, key: PathSegment): boolean {
  if (Array.isArray(container) && typeof key === "number") {
    return key in container;
  }
  return String(key) in (container as PathNode);
}

function deleteAt(container: PathContainer, key: PathSegment): void {
  if (Array.isArray(container) && typeof key === "number") {
    // Runtime overrides use arrays as sparse index-addressed patch maps, so
    // deleting an entry must not retarget later indexes.
    container[key] = undefined;
    return;
  }
  delete (container as PathNode)[String(key)];
}

function isEmptyContainer(value: unknown): boolean {
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => entry === undefined);
  }
  return false;
}

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: Path;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  const parts: Path = [];
  let currentSegment = "";
  let state: "bare" | "bracket_unquoted" | "bracket_single" | "bracket_double" = "bare";

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (state === "bare") {
      if (char === "[") {
        if (currentSegment.trim()) {
          parts.push(currentSegment.trim());
        }
        currentSegment = "";
        if (trimmed[i + 1] === '"') {
          state = "bracket_double";
          i++;
        } else if (trimmed[i + 1] === "'") {
          state = "bracket_single";
          i++;
        } else {
          state = "bracket_unquoted";
        }
      } else if (char === ".") {
        if (currentSegment.trim()) {
          parts.push(currentSegment.trim());
          currentSegment = "";
        } else if (currentSegment.length > 0) {
          // Whitespace-only segment between dots (e.g. "foo. .bar")
          return { ok: false, error: "Invalid path. Use dot notation (e.g. foo.bar)." };
        } else if (parts.length === 0 || trimmed[i - 1] === ".") {
          // Leading dot or consecutive dots (e.g. ".foo" or "foo..bar")
          return { ok: false, error: "Invalid path. Use dot notation (e.g. foo.bar)." };
        }
      } else {
        currentSegment += char;
      }
    } else if (state === "bracket_double") {
      if (char === '"' && trimmed[i + 1] === "]") {
        parts.push(currentSegment);
        currentSegment = "";
        state = "bare";
        i++;
      } else {
        currentSegment += char;
      }
    } else if (state === "bracket_single") {
      if (char === "'" && trimmed[i + 1] === "]") {
        parts.push(currentSegment);
        currentSegment = "";
        state = "bare";
        i++;
      } else {
        currentSegment += char;
      }
    } else if (state === "bracket_unquoted") {
      if (char === "]") {
        const bracketSegment = currentSegment.trim();
        if (/^\d+$/.test(bracketSegment)) {
          parts.push(Number.parseInt(bracketSegment, 10));
        } else {
          parts.push(bracketSegment);
        }
        currentSegment = "";
        state = "bare";
      } else {
        currentSegment += char;
      }
    }
  }

  if (state !== "bare") {
    return { ok: false, error: "Invalid path. Unclosed bracket." };
  }

  if (currentSegment.trim()) {
    parts.push(currentSegment.trim());
  } else if (trimmed.endsWith(".") || (currentSegment.length > 0 && parts.length === 0)) {
    return { ok: false, error: "Invalid path. Use dot notation (e.g. foo.bar)." };
  }

  if (parts.length === 0) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  if (parts.some((part) => part === "")) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }

  if (parts.some((part) => typeof part === "string" && isBlockedObjectKey(part))) {
    return { ok: false, error: "Invalid path segment." };
  }

  return { ok: true, path: parts };
}

export function setConfigValueAtPath(root: PathNode, path: Path, value: unknown): void {
  if (path.length === 0) {
    return;
  }

  let cursor: PathContainer = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = getAt(cursor, key);

    if (!isPathContainer(next)) {
      const replacement: PathContainer = typeof path[idx + 1] === "number" ? [] : {};
      setAt(cursor, key, replacement);
      cursor = replacement;
      continue;
    }

    cursor = next;
  }

  setAt(cursor, path[path.length - 1], value);
}

export function unsetConfigValueAtPath(root: PathNode, path: Path): boolean {
  if (path.length === 0) {
    return false;
  }

  const stack: Array<{ node: PathContainer; key: PathSegment }> = [];
  let cursor: PathContainer = root;

  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = getAt(cursor, key);
    if (!isPathContainer(next)) {
      return false;
    }

    stack.push({ node: cursor, key });
    cursor = next;
  }

  const leafKey = path[path.length - 1];
  if (!hasAt(cursor, leafKey)) {
    return false;
  }

  deleteAt(cursor, leafKey);

  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = getAt(node, key);

    if (isEmptyContainer(child)) {
      deleteAt(node, key);
    } else {
      break;
    }
  }

  return true;
}

export function getConfigValueAtPath(root: PathNode, path: Path): unknown {
  let cursor: unknown = root;

  for (const key of path) {
    if (!isPathContainer(cursor)) {
      return undefined;
    }
    cursor = getAt(cursor, key);
  }

  return cursor;
}
