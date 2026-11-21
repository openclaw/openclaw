import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";

export function collectConfigWriteChangedPaths(
  base: unknown,
  target: unknown,
  explicitPaths: readonly (readonly string[])[],
): Set<string> {
  const changedPaths = new Set<string>();
  collectChangedPaths(base, target, "", changedPaths);
  for (const changedPath of explicitPaths) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  return changedPaths;
}

export function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Object.is(base, target)) {
    return;
  }
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isRecord(base) && isRecord(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = Object.hasOwn(base, key);
      const hasTarget = Object.hasOwn(target, key);
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}
