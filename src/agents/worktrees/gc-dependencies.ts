import path from "node:path";
import type { ManagedWorktreeRecord } from "./types.js";

/** Canonical path ancestry for one allocation-owned inventory. */
export function indexWorktreePaths(records: readonly Pick<ManagedWorktreeRecord, "id" | "path">[]) {
  const key = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const owners = new Map<string, string[]>();
  for (const record of records) {
    const normalized = key(record.path);
    const ids = owners.get(normalized) ?? [];
    ids.push(record.id);
    owners.set(normalized, ids);
  }
  return function* ancestors(target: string) {
    let current = key(target);
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
