import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./shared.js";

function isArrayIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function expectedContainer(nextSegment: string): "array" | "object" {
  return isArrayIndexSegment(nextSegment) ? "array" : "object";
}

function parseArrayLeafTarget(
  cursor: unknown,
  leaf: string,
  segments: string[],
): { array: unknown[]; index: number } | null {
  if (!Array.isArray(cursor)) {
    return null;
  }
  if (!isArrayIndexSegment(leaf)) {
    throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
  }
  return { array: cursor, index: Number.parseInt(leaf, 10) };
}

function traverseToLeafParent(params: {
  root: unknown;
  segments: string[];
  requireExistingSegment: boolean;
}): unknown {
  if (params.segments.length === 0) {
    throw new Error("Target path is empty.");
  }

  let cursor: unknown = params.root;
  for (let index = 0; index < params.segments.length - 1; index += 1) {
    const segment = params.segments[index] ?? "";
    if (Array.isArray(cursor)) {
      if (!isArrayIndexSegment(segment)) {
        throw new Error(
          `Invalid array index segment "${segment}" at ${params.segments.join(".")}.`,
        );
      }
      const arrayIndex = Number.parseInt(segment, 10);
      if (params.requireExistingSegment && (arrayIndex < 0 || arrayIndex >= cursor.length)) {
        throw new Error(
          `Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`,
        );
      }
      cursor = cursor[arrayIndex];
      continue;
    }

    if (!isRecord(cursor)) {
      throw new Error(
        `Invalid path shape at ${params.segments.slice(0, index).join(".") || "<root>"}.`,
      );
    }
    if (params.requireExistingSegment && !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      throw new Error(
        `Path segment does not exist at ${params.segments.slice(0, index + 1).join(".")}.`,
      );
    }
    cursor = cursor[segment];
  }
  return cursor;
}

export function getPath(root: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    return undefined;
  }
  let cursor: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      if (!isArrayIndexSegment(segment)) {
        return undefined;
      }
      cursor = cursor[Number.parseInt(segment, 10)];
      continue;
    }
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

export function setPathCreateStrict(
  root: Record<string, unknown>,
  segments: string[],
  value: unknown,
): boolean {
  if (segments.length === 0) {
    throw new Error("Target path is empty.");
  }
  let cursor: unknown = root;
  let changed = false;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    const nextSegment = segments[index + 1] ?? "";
    const needs = expectedContainer(nextSegment);

    if (Array.isArray(cursor)) {
      if (!isArrayIndexSegment(segment)) {
        throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
      }
      const arrayIndex = Number.parseInt(segment, 10);
      const existing = cursor[arrayIndex];
      if (existing === undefined || existing === null) {
        cursor[arrayIndex] = needs === "array" ? [] : {};
        changed = true;
      } else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) {
        throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
      }
      cursor = cursor[arrayIndex];
      continue;
    }

    if (!isRecord(cursor)) {
      throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
    }
    const existing = cursor[segment];
    if (existing === undefined || existing === null) {
      cursor[segment] = needs === "array" ? [] : {};
      changed = true;
    } else if (needs === "array" ? !Array.isArray(existing) : !isRecord(existing)) {
      throw new Error(`Invalid path shape at ${segments.slice(0, index + 1).join(".")}.`);
    }
    cursor = cursor[segment];
  }

  const leaf = segments[segments.length - 1] ?? "";
  const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
  if (arrayTarget) {
    if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
      arrayTarget.array[arrayTarget.index] = value;
      changed = true;
    }
    return changed;
  }
  if (!isRecord(cursor)) {
    throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
  }
  if (!isDeepStrictEqual(cursor[leaf], value)) {
    cursor[leaf] = value;
    changed = true;
  }
  return changed;
}

export function setPathExistingStrict(
  root: Record<string, unknown>,
  segments: string[],
  value: unknown,
): boolean {
  const cursor = traverseToLeafParent({ root, segments, requireExistingSegment: true });

  const leaf = segments[segments.length - 1] ?? "";
  const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
  if (arrayTarget) {
    if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) {
      throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
    }
    if (!isDeepStrictEqual(arrayTarget.array[arrayTarget.index], value)) {
      arrayTarget.array[arrayTarget.index] = value;
      return true;
    }
    return false;
  }
  if (!isRecord(cursor)) {
    throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
  }
  if (!isDeepStrictEqual(cursor[leaf], value)) {
    cursor[leaf] = value;
    return true;
  }
  return false;
}

export function deletePathStrict(root: Record<string, unknown>, segments: string[]): boolean {
  const cursor = traverseToLeafParent({ root, segments, requireExistingSegment: false });

  const leaf = segments[segments.length - 1] ?? "";
  const arrayTarget = parseArrayLeafTarget(cursor, leaf, segments);
  if (arrayTarget) {
    if (arrayTarget.index < 0 || arrayTarget.index >= arrayTarget.array.length) {
      return false;
    }
    // Arrays are compacted to preserve predictable index semantics.
    arrayTarget.array.splice(arrayTarget.index, 1);
    return true;
  }
  if (!isRecord(cursor)) {
    throw new Error(`Invalid path shape at ${segments.slice(0, -1).join(".") || "<root>"}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    return false;
  }
  delete cursor[leaf];
  return true;
}
