import type { SessionActorTarget } from "./session-actor-contract.js";
import type { FileTarget, ReplicaCell, ReplicaPool } from "./session-actor-replica.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

export function sessionActorReplicaTargetKey(target: SessionActorTarget): string {
  const { database, sessionKey } = target;
  return JSON.stringify(
    database.kind === "file"
      ? [database.kind, database.physicalIdentity, database.birthtime, sessionKey]
      : [database.kind, database.handle, database.incarnation, sessionKey],
  );
}

export function retainSessionActorReplicaCell(pool: ReplicaPool, target: FileTarget): ReplicaCell {
  const key = sessionActorReplicaTargetKey(target);
  let cell = pool.cells.get(key);
  if (!cell) {
    cell = {
      target,
      publicationScope: {
        sessionKeys: collectSessionEntryLookupKeys(target.sessionKey),
        storePaths: new Set([target.database.nativeLocation]),
        databaseIdentities: new Set([target.database.physicalIdentity]),
      },
      handles: 0,
      bytes: 0,
      transcriptBytes: 0,
    };
    pool.cells.set(key, cell);
    indexSessionActorReplicaCell(pool, cell);
  }
  return cell;
}

export function indexSessionActorReplicaCell(pool: ReplicaPool, cell: ReplicaCell): void {
  for (const key of cell.publicationScope.sessionKeys) {
    let cells = pool.cellsBySessionKey.get(key);
    if (!cells) {
      cells = new Set();
      pool.cellsBySessionKey.set(key, cells);
    }
    // Match the pool's LRU order when a publication reaches several aliases.
    cells.delete(cell);
    cells.add(cell);
  }
}

export function unindexSessionActorReplicaCell(pool: ReplicaPool, cell: ReplicaCell): void {
  for (const key of cell.publicationScope.sessionKeys) {
    const cells = pool.cellsBySessionKey.get(key);
    cells?.delete(cell);
    if (cells?.size === 0) {
      pool.cellsBySessionKey.delete(key);
    }
  }
}

// Residency is a heap estimate, not a wire-size limit. Trusted postimages are
// acyclic plain data; count strings without allocating or scanning their JSON.
export function estimateSessionActorReplicaBytes(
  value: unknown,
  sizes?: WeakMap<object, number>,
  memoizeDescendants = true,
): number {
  if (typeof value === "string") {
    return 16 + value.length * 2;
  }
  if (!value || typeof value !== "object") {
    return 8;
  }
  const known = sizes?.get(value);
  if (known !== undefined) {
    return known;
  }
  const childSizes = memoizeDescendants ? sizes : undefined;
  let bytes = 32;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (index in value) {
        bytes += 16 + estimateSessionActorReplicaBytes(value[index], childSizes, false);
      }
    }
  } else {
    for (const key in value) {
      bytes +=
        16 + key.length * 2 + estimateSessionActorReplicaBytes(Reflect.get(value, key), childSizes);
    }
  }
  sizes?.set(value, bytes);
  return bytes;
}
