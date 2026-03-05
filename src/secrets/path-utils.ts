import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "./shared.js";

function isArrayIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function expectedContainer(nextSegment: string): "array" | "object" {
  return isArrayIndexSegment(nextSegment) ? "array" : "object";
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
  root: OpenClawConfig,
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
  if (Array.isArray(cursor)) {
    if (!isArrayIndexSegment(leaf)) {
      throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
    }
    const arrayIndex = Number.parseInt(leaf, 10);
    if (!isDeepStrictEqual(cursor[arrayIndex], value)) {
      cursor[arrayIndex] = value;
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
  root: OpenClawConfig,
  segments: string[],
  value: unknown,
): boolean {
  if (segments.length === 0) {
    throw new Error("Target path is empty.");
  }
  let cursor: unknown = root;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    if (Array.isArray(cursor)) {
      if (!isArrayIndexSegment(segment)) {
        throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
      }
      const arrayIndex = Number.parseInt(segment, 10);
      if (arrayIndex < 0 || arrayIndex >= cursor.length) {
        throw new Error(
          `Path segment does not exist at ${segments.slice(0, index + 1).join(".")}.`,
        );
      }
      cursor = cursor[arrayIndex];
      continue;
    }
    if (!isRecord(cursor)) {
      throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      throw new Error(`Path segment does not exist at ${segments.slice(0, index + 1).join(".")}.`);
    }
    cursor = cursor[segment];
  }

  const leaf = segments[segments.length - 1] ?? "";
  if (Array.isArray(cursor)) {
    if (!isArrayIndexSegment(leaf)) {
      throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
    }
    const arrayIndex = Number.parseInt(leaf, 10);
    if (arrayIndex < 0 || arrayIndex >= cursor.length) {
      throw new Error(`Path segment does not exist at ${segments.join(".")}.`);
    }
    if (!isDeepStrictEqual(cursor[arrayIndex], value)) {
      cursor[arrayIndex] = value;
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

export function deletePathStrict(root: OpenClawConfig, segments: string[]): boolean {
  if (segments.length === 0) {
    throw new Error("Target path is empty.");
  }
  let cursor: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    if (Array.isArray(cursor)) {
      if (!isArrayIndexSegment(segment)) {
        throw new Error(`Invalid array index segment "${segment}" at ${segments.join(".")}.`);
      }
      cursor = cursor[Number.parseInt(segment, 10)];
      continue;
    }
    if (!isRecord(cursor)) {
      throw new Error(`Invalid path shape at ${segments.slice(0, index).join(".") || "<root>"}.`);
    }
    cursor = cursor[segment];
  }

  const leaf = segments[segments.length - 1] ?? "";
  if (Array.isArray(cursor)) {
    if (!isArrayIndexSegment(leaf)) {
      throw new Error(`Invalid array index segment "${leaf}" at ${segments.join(".")}.`);
    }
    const arrayIndex = Number.parseInt(leaf, 10);
    if (arrayIndex < 0 || arrayIndex >= cursor.length) {
      return false;
    }
    // Arrays are compacted to preserve predictable index semantics.
    cursor.splice(arrayIndex, 1);
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
