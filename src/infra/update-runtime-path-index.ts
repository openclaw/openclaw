import path from "node:path";
import { isPathInside } from "./path-guards.js";

/**
 * Index immutable lexical roots for one inventory/materialization operation.
 * Ancestors select candidates, but the existing guard still decides containment.
 * Input order, not the nearest ancestor, owns overlapping-root precedence.
 */
export function createRuntimePathLookup<T>(entries: Iterable<readonly [string, T]>) {
  const paths = process.platform === "win32" ? path.win32 : path.posix;
  const windows = process.platform === "win32";
  const keyFor = (value: string): string | undefined => {
    // Relative roots depend on cwd (and Windows per-drive cwd). Namespace and
    // colon-bearing Windows paths retain the guard's full relative-path rules.
    if (!paths.isAbsolute(value)) {
      return undefined;
    }
    const resolved = paths.resolve(value);
    if (windows) {
      if (
        (!/^[a-z]:\\/iu.test(resolved) && !/^\\\\[^?.\\][^\\]*\\[^\\]+/u.test(resolved)) ||
        resolved.includes(":", 2)
      ) {
        return undefined;
      }
      return resolved.toLowerCase();
    }
    return resolved;
  };
  const roots = Array.from(entries, ([root, value], order) => ({ root, value, order }));
  type Entry = (typeof roots)[number];
  const indexed = new Map<string, Entry[]>();
  const fallback: Entry[] = [];
  for (const entry of roots) {
    const key = keyFor(entry.root);
    if (key === undefined) {
      fallback.push(entry);
    } else {
      const bucket = indexed.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        indexed.set(key, [entry]);
      }
    }
  }
  return (value: string): T | undefined => {
    const key = keyFor(value);
    if (key === undefined) {
      return roots.find((entry) => isPathInside(entry.root, value))?.value;
    }
    let first: Entry | undefined;
    const consider = (candidates: readonly Entry[]) => {
      for (const entry of candidates) {
        if (first && entry.order >= first.order) {
          break;
        }
        if (isPathInside(entry.root, value)) {
          first = entry;
          break;
        }
      }
    };
    for (let ancestor = key; ; ancestor = paths.dirname(ancestor)) {
      const bucket = indexed.get(ancestor);
      if (bucket) {
        consider(bucket);
      }
      if (paths.dirname(ancestor) === ancestor) {
        break;
      }
    }
    consider(fallback);
    return first?.value;
  };
}
