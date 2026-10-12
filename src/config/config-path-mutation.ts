import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { OpenClawConfig } from "./types.js";

const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;
const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

function unsetPathForWriteAt(value: unknown, pathSegments: string[], depth: number): unknown {
  if (depth >= pathSegments.length) {
    return value;
  }
  const segment = expectDefined(pathSegments[depth], "path segments entry at depth");
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(segment);
    if (index === undefined || index >= value.length) {
      return value;
    }
    const child = isLeaf
      ? WRITE_PRUNED_OBJECT
      : unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (Object.is(child, value[index])) {
      return value;
    }
    const next = value.slice();
    if (child === WRITE_PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child;
    }
    return next;
  }

  if (isBlockedObjectKey(segment) || !isRecord(value) || !Object.hasOwn(value, segment)) {
    return value;
  }
  const child = isLeaf
    ? WRITE_PRUNED_OBJECT
    : unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (Object.is(child, value[segment])) {
    return value;
  }
  const next: Record<string, unknown> = { ...value };
  if (child === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child;
  }
  return Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next;
}

export function applyUnsetPathsForWrite(
  root: OpenClawConfig,
  unsetPaths: readonly string[][] | undefined,
): OpenClawConfig;
export function applyUnsetPathsForWrite(
  root: unknown,
  unsetPaths: readonly string[][] | undefined,
): unknown;
export function applyUnsetPathsForWrite(
  root: unknown,
  unsetPaths: readonly string[][] | undefined,
): unknown {
  let next = root;
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    const unsetResult = unsetPathForWriteAt(next, unsetPath, 0);
    if (unsetResult === WRITE_PRUNED_OBJECT) {
      next = {};
    } else if (isRecord(unsetResult)) {
      next = unsetResult;
    }
  }
  return next;
}

export function resolveManagedUnsetPathsForWrite(
  unsetPaths: readonly string[][] | undefined,
): string[][] {
  const next: string[][] = [];
  for (const managedPath of MANAGED_CONFIG_UNSET_PATHS) {
    next.push(Array.from(managedPath));
  }
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    if (next.some((existing) => isDeepStrictEqual(existing, unsetPath))) {
      continue;
    }
    next.push([...unsetPath]);
  }
  return next;
}
