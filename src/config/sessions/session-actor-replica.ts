import {
  readSqliteDatabaseScopedWriteTokenForPath,
  readSqliteDatabaseWriteTokenForPath,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sessionChangeAffectsStoredRow } from "../../sessions/session-row-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "../../state/openclaw-agent-execution-contract.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionEntryPublicationSource,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type {
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorTarget,
} from "./session-actor-contract.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshot-values.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

export type SessionActorEntryFacts = Pick<
  SessionActorHotState,
  "target" | "entry" | "writeToken" | "dependencySessionIds"
> &
  Partial<Pick<SessionActorHotState, "participants" | "members">> & {
    snapshots: "full" | readonly SessionEntrySnapshotField[];
  };

type FileTarget = SessionActorTarget & { database: AgentDatabaseExecutionFileIdentity };
type EphemeralTarget = SessionActorTarget & {
  database: AgentDatabaseIncognitoIdentity;
};
type ReplicaCell = {
  target: SessionActorTarget;
  snapshot?: SessionActorHotState;
  entry?: SessionActorEntryFacts;
  generation?: string;
  reservation: number;
  handles: number;
  pending: number;
  bytes: number;
};
type ReplicaPool = {
  cells: Map<string, ReplicaCell>;
  snapshots: number;
  bytes: number;
  unsubscribe?: () => void;
};

const MAX_SNAPSHOTS = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const pool = resolveGlobalSingleton<ReplicaPool>(
  Symbol.for("openclaw.sessionActorReplicas"),
  () => ({ cells: new Map(), snapshots: 0, bytes: 0 }),
  (owner) => {
    owner.unsubscribe?.();
    owner.unsubscribe = undefined;
    for (const cell of owner.cells.values()) {
      cell.reservation += 1;
      discard(cell);
    }
    owner.cells.clear();
    owner.snapshots = 0;
    owner.bytes = 0;
  },
);

function ensureReplicaSubscription(): void {
  if (pool.unsubscribe) {
    return;
  }
  // Lifecycle cleanup also clears listeners; subscribe only when this owner resumes.
  pool.unsubscribe = sessionChanges.subscribeFacts((change) => {
    // Receipt installation reorders the LRU map, so visit the original cells once.
    const cellsBeforePublication = [...pool.cells.values()];
    for (const cell of cellsBeforePublication) {
      const { database, sessionKey } = cell.target;
      if (
        database.kind !== "file" ||
        !sessionChangeAffectsStoredRow(change, {
          sessionKeys: collectSessionEntryLookupKeys(sessionKey),
          storePaths: new Set([database.nativeLocation]),
          databaseIdentities: new Set([database.physicalIdentity]),
        })
      ) {
        continue;
      }
      if (change.factsInvalidated) {
        cell.reservation += 1;
      }
      // A command's partial publication precedes its full receipt. Its native
      // token rejects superseded postimages without cancelling that receipt.
      const prepared =
        !("all" in change) && !change.factsInvalidated && change.sessionKey === sessionKey
          ? readPreparedSessionEntryChange(change, sessionKey)
          : undefined;
      const source = readPreparedSessionEntryPublicationSource(change);
      const unchangedMarker =
        !prepared &&
        !("all" in change) &&
        !change.factsInvalidated &&
        (!change.facts || change.facts.kind === "unchanged");
      const unchangedEntry = unchangedMarker ? cell.entry : undefined;
      discard(cell);
      if (unchangedEntry) {
        // Transcript/metadata markers do not revoke an installed entry receipt.
        // Its original scoped token still rejects any unaccounted storage write.
        cell.entry = unchangedEntry;
        cell.bytes = JSON.stringify(unchangedEntry).length * 2;
        pool.snapshots += 1;
        pool.bytes += cell.bytes;
      }
      if (
        prepared?.fullEntry &&
        source.identity === database.physicalIdentity &&
        prepared.source.writeToken === readSqliteDatabaseWriteTokenForPath(database.nativeLocation)
      ) {
        const dependencySessionIds = [prepared.fullEntry.sessionId];
        const writeToken = readSqliteDatabaseScopedWriteTokenForPath(database.nativeLocation, [
          ...collectSessionEntryLookupKeys(sessionKey),
          ...dependencySessionIds.map(sqliteSessionIdWriteScope),
        ]);
        if (writeToken) {
          cell.entry = freezeJsonSnapshot({
            target: cell.target,
            entry: structuredClone(prepared.fullEntry),
            dependencySessionIds,
            writeToken,
            snapshots: "full",
          });
          cell.bytes = JSON.stringify(cell.entry).length * 2;
          pool.snapshots += 1;
          pool.bytes += cell.bytes;
          touch(cell);
        }
      }
      // Keep a bounded empty slot through pending publication so its complete
      // entry receipt can install without retaining a reader handle.
      if (!change.factsInvalidated && !unchangedMarker) {
        forgetUnused(cell);
      }
    }
  });
}

function targetKey(target: SessionActorTarget): string {
  const { database, sessionKey } = target;
  return JSON.stringify(
    database.kind === "file"
      ? [database.kind, database.physicalIdentity, database.birthtime, sessionKey]
      : [database.kind, database.handle, database.incarnation, sessionKey],
  );
}

function discard(cell: ReplicaCell): void {
  if (cell.snapshot || cell.entry) {
    pool.snapshots -= 1;
  }
  pool.bytes -= cell.bytes;
  cell.snapshot = undefined;
  cell.entry = undefined;
  cell.bytes = 0;
}

function forgetUnused(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  if (
    !cell.handles &&
    !cell.pending &&
    !cell.snapshot &&
    !cell.entry &&
    pool.cells.get(key) === cell
  ) {
    pool.cells.delete(key);
  }
}

function touch(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  pool.cells.delete(key);
  pool.cells.set(key, cell);
  for (const candidate of pool.cells.values()) {
    if (!candidate.snapshot && !candidate.entry) {
      forgetUnused(candidate);
      continue;
    }
    if (
      pool.cells.size <= MAX_SNAPSHOTS &&
      pool.snapshots <= MAX_SNAPSHOTS &&
      (pool.bytes <= MAX_BYTES || pool.snapshots === 1)
    ) {
      break;
    }
    discard(candidate);
    forgetUnused(candidate);
  }
}

/** Entry projections share actor residency; they never certify transcript or live authority. */
export function readSessionActorEntryFacts(
  target: FileTarget,
): (SessionActorEntryFacts & { incarnation: string }) | undefined {
  ensureReplicaSubscription();
  const cell = pool.cells.get(targetKey(target));
  const state = cell?.snapshot ?? cell?.entry;
  if (!cell || !state || cell.generation === undefined) {
    return undefined;
  }
  const current = readDatabasePathIdentitySync(target.database.nativeLocation);
  if (
    current.key !== `file:${target.database.physicalIdentity}` ||
    current.birthtime !== target.database.birthtime
  ) {
    discard(cell);
    forgetUnused(cell);
    return undefined;
  }
  const token = readSqliteDatabaseScopedWriteTokenForPath(target.database.nativeLocation, [
    ...collectSessionEntryLookupKeys(target.sessionKey),
    ...state.dependencySessionIds.map(sqliteSessionIdWriteScope),
  ]);
  if (!token) {
    return undefined;
  }
  if (token !== state.writeToken) {
    discard(cell);
    forgetUnused(cell);
    return undefined;
  }
  touch(cell);
  const snapshots: SessionActorEntryFacts["snapshots"] = cell.snapshot
    ? "full"
    : (cell.entry?.snapshots ?? "full");
  return structuredClone({
    target,
    entry: state.entry,
    members: state.members,
    participants: state.participants,
    snapshots,
    dependencySessionIds: state.dependencySessionIds,
    writeToken: token,
    incarnation: cell.generation,
  });
}

/** A single cold entry batch and actor commands publish into the same bounded MAIN owner. */
export function retainSessionActorEntryFacts(
  target: FileTarget,
  facts: Omit<SessionActorEntryFacts, "target" | "writeToken" | "dependencySessionIds">,
  incarnation: string,
): void {
  ensureReplicaSubscription();
  const dependencySessionIds = facts.entry ? [facts.entry.sessionId] : [];
  const writeToken = readSqliteDatabaseScopedWriteTokenForPath(target.database.nativeLocation, [
    ...collectSessionEntryLookupKeys(target.sessionKey),
    ...dependencySessionIds.map(sqliteSessionIdWriteScope),
  ]);
  if (!writeToken) {
    return;
  }
  const key = targetKey(target);
  let cell = pool.cells.get(key);
  if (!cell) {
    cell = { target, reservation: 0, handles: 0, pending: 0, bytes: 0 };
    pool.cells.set(key, cell);
  }
  if (cell.snapshot) {
    const current = readSqliteDatabaseScopedWriteTokenForPath(target.database.nativeLocation, [
      ...collectSessionEntryLookupKeys(target.sessionKey),
      ...cell.snapshot.dependencySessionIds.map(sqliteSessionIdWriteScope),
    ]);
    if (current === cell.snapshot.writeToken) {
      touch(cell);
      return;
    }
  }
  discard(cell);
  cell.entry = freezeJsonSnapshot(
    structuredClone({
      ...facts,
      target,
      dependencySessionIds,
      writeToken,
    }),
  );
  cell.generation = incarnation;
  cell.bytes = JSON.stringify(cell.entry).length * 2;
  pool.snapshots += 1;
  pool.bytes += cell.bytes;
  touch(cell);
}

/** Handles retain their own authority; complete physical postimages survive handle release. */
export function createSessionActorReplica(
  params: { lifetime: SessionActorLifetime } & (
    | { target: FileTarget; currentWriteToken?: never; currentGeneration: () => string | undefined }
    | {
        target: EphemeralTarget;
        currentWriteToken: (state: SessionActorHotState) => string | undefined;
        currentGeneration?: never;
      }
  ),
) {
  ensureReplicaSubscription();
  const target = freezeJsonSnapshot(structuredClone(params.target));
  const key = targetKey(target);
  let cell = pool.cells.get(key);
  if (!cell) {
    cell = { target, reservation: 0, handles: 0, pending: 0, bytes: 0 };
    pool.cells.set(key, cell);
  }
  const owned = cell;
  owned.handles += 1;
  let closed = false;

  const invalidate = () => {
    owned.reservation += 1;
    discard(owned);
    forgetUnused(owned);
  };
  const generation = (): string | undefined => {
    try {
      return target.database.kind === "file"
        ? params.currentGeneration?.()
        : target.database.incarnation;
    } catch {
      return undefined;
    }
  };
  const currentToken = (state: SessionActorHotState): string | undefined => {
    const database = target.database;
    if (database.kind !== "file") {
      return params.currentWriteToken?.(state);
    }
    try {
      const identity = readDatabasePathIdentitySync(database.nativeLocation);
      if (
        identity.key !== `file:${database.physicalIdentity}` ||
        (database.birthtime !== undefined && identity.birthtime !== database.birthtime)
      ) {
        return undefined;
      }
      return readSqliteDatabaseScopedWriteTokenForPath(database.nativeLocation, [
        ...collectSessionEntryLookupKeys(target.sessionKey),
        ...state.dependencySessionIds.map(sqliteSessionIdWriteScope),
      ]);
    } catch {
      return undefined;
    }
  };
  const accepts = (
    state: SessionActorHotState,
    expectedGeneration: string | undefined,
    writeToken = currentToken(state),
  ): boolean =>
    expectedGeneration !== undefined &&
    expectedGeneration === generation() &&
    targetKey(state.target) === key &&
    state.writeToken === writeToken;
  const install = (
    state: SessionActorHotState,
    expectedGeneration: string | undefined,
  ): boolean => {
    const detached = freezeJsonSnapshot(structuredClone(state));
    if (!accepts(detached, expectedGeneration)) {
      discard(owned);
      return false;
    }
    discard(owned);
    owned.snapshot = detached;
    owned.generation = expectedGeneration;
    owned.bytes = JSON.stringify(detached).length * 2;
    pool.snapshots += 1;
    pool.bytes += owned.bytes;
    touch(owned);
    return owned.snapshot !== undefined;
  };
  const begin = () => {
    params.lifetime.assertCurrent();
    if (closed) {
      throw new Error("Session actor replica is closed");
    }
    owned.pending += 1;
    invalidate();
    const selected = owned.reservation;
    const expectedGeneration = generation();
    let settled = false;
    return (operation: (expectedGeneration: string | undefined) => boolean): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      try {
        return selected === owned.reservation && operation(expectedGeneration);
      } finally {
        owned.pending -= 1;
        forgetUnused(owned);
      }
    };
  };

  return {
    /** Each borrower validates its current physical generation before disclosure. */
    read(): SessionActorHotState | undefined {
      params.lifetime.assertReadable();
      if (closed || !owned.snapshot) {
        return undefined;
      }
      const token = currentToken(owned.snapshot);
      if (token === undefined) {
        // An unrelated unsettled writer can temporarily fence disclosure without
        // discarding this session's still-valid postimage.
        return undefined;
      }
      if (!accepts(owned.snapshot, owned.generation, token)) {
        invalidate();
        return undefined;
      }
      touch(owned);
      return structuredClone(owned.snapshot);
    },
    beginRead() {
      const settle = begin();
      return {
        install(state: SessionActorHotState): boolean {
          return settle((expectedGeneration) => install(state, expectedGeneration));
        },
        cancel(): void {
          settle(() => false);
        },
      };
    },
    beginCommand() {
      const previous = owned.snapshot;
      const settle = begin();
      return {
        settle<Value>(outcome: SessionActorOutcome<Value>): boolean {
          return settle((expectedGeneration) => {
            if (outcome.kind === "rolled-back") {
              return previous !== undefined && install(previous, expectedGeneration);
            }
            if (outcome.kind === "unknown") {
              discard(owned);
              return false;
            }
            if (outcome.kind === "stale-version") {
              return install(outcome.postimage, expectedGeneration);
            }
            // The command owner has already validated the committed receipt.
            // Closing revokes this handle's disclosure, not accepted commit custody.
            return install(outcome.receipt.postimage, expectedGeneration);
          });
        },
      };
    },
    invalidate,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      owned.handles -= 1;
      forgetUnused(owned);
    },
  };
}
