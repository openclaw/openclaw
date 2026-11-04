import path from "node:path";
import type { ManagedWorktreeRecord } from "./types.js";

type OwnedPath = Pick<ManagedWorktreeRecord, "id" | "path">;

function pathKey(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAncestors(owners: ReadonlyMap<string, readonly string[]>) {
  return function* ancestors(target: string) {
    let current = pathKey(target);
    for (;;) {
      yield* owners.get(current) ?? [];
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  };
}

/** Retain immutable ancestry snapshots of fresh Git inventories, including external aliases. */
export function createPreparedWorktreePathIndex() {
  let previous: readonly OwnedPath[] = [];
  const paths = new Map<string, { key: string; count: number }>();
  let owners = new Map<string, string[]>();
  let ancestors = pathAncestors(owners);
  const equal = (a: OwnedPath, b: OwnedPath) => a.id === b.id && a.path === b.path;
  return (records: readonly OwnedPath[]) => {
    let start = 0;
    while (
      start < previous.length &&
      start < records.length &&
      equal(previous[start]!, records[start]!)
    ) {
      start++;
    }
    if (start === previous.length && start === records.length) {
      return ancestors;
    }
    let oldEnd = previous.length;
    let newEnd = records.length;
    while (oldEnd > start && newEnd > start && equal(previous[oldEnd - 1]!, records[newEnd - 1]!)) {
      oldEnd--;
      newEnd--;
    }
    const changed = new Map<string, string[]>();
    for (let index = start; index < oldEnd; index++) {
      const raw = previous[index]!.path;
      const entry = paths.get(raw)!;
      changed.set(entry.key, []);
      if (--entry.count === 0) {
        paths.delete(raw);
      }
    }
    for (let index = start; index < newEnd; index++) {
      const raw = records[index]!.path;
      let entry = paths.get(raw);
      if (!entry) {
        entry = { key: pathKey(raw), count: 0 };
        paths.set(raw, entry);
      }
      entry.count++;
      changed.set(entry.key, []);
    }
    // Only changed buckets are replaced; in-flight preparations keep their original snapshot.
    for (const record of records) {
      changed.get(paths.get(record.path)!.key)?.push(record.id);
    }
    owners = new Map(owners);
    for (const [key, ids] of changed) {
      if (ids.length) {
        owners.set(key, ids);
      } else {
        owners.delete(key);
      }
    }
    previous = records;
    ancestors = pathAncestors(owners);
    return ancestors;
  };
}

/** Canonical path ancestry for one allocation-owned inventory. */
export function indexWorktreePaths(records: readonly OwnedPath[]) {
  const owners = new Map<string, string[]>();
  for (const record of records) {
    const normalized = pathKey(record.path);
    const ids = owners.get(normalized) ?? [];
    ids.push(record.id);
    owners.set(normalized, ids);
  }
  return pathAncestors(owners);
}

export function indexWorktreeEvictionDependencies(
  records: readonly ManagedWorktreeRecord[],
  commonDirs: ReadonlyMap<string, string | undefined>,
) {
  const ancestors = indexWorktreePaths(records);
  const dependents = new Map<string, Set<string>>();
  const sourceContainers = new Map<string, Set<string>>();
  const unresolved = new Map<string, ManagedWorktreeRecord>();
  for (const record of records) {
    const commonDir = commonDirs.get(record.repoRoot);
    if (commonDir === undefined) {
      unresolved.set(record.id, record);
    }
    for (const [target, source] of [
      [record.path, false],
      [record.repoRoot, true],
      [commonDir, true],
    ] as const) {
      if (target === undefined) {
        continue;
      }
      for (const id of ancestors(target)) {
        if (id === record.id) {
          continue;
        }
        const children = dependents.get(id) ?? new Set<string>();
        children.add(record.id);
        dependents.set(id, children);
        if (source) {
          const containers = sourceContainers.get(record.id) ?? new Set<string>();
          containers.add(id);
          sourceContainers.set(record.id, containers);
        }
      }
    }
  }
  return { dependents, sourceContainers, unresolved };
}
