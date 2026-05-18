import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../utils.js";

export type ConfigPathSegments = string[];

function formatConfigPath(segments: readonly string[]): string {
  return segments.length > 0 ? segments.join(".") : "<root>";
}

export function diffConfigPathSegments(
  prev: unknown,
  next: unknown,
  prefix: readonly string[] = [],
): ConfigPathSegments[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: ConfigPathSegments[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPaths = diffConfigPathSegments(prevValue, nextValue, [...prefix, key]);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [[...prefix]];
}

export function diffConfigPaths(prev: unknown, next: unknown): string[] {
  return diffConfigPathSegments(prev, next).map(formatConfigPath);
}
