import {
  readSqliteDatabaseScopedWriteTokenForPath,
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
import type {
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

type FileTarget = SessionActorTarget & { database: AgentDatabaseExecutionFileIdentity };
type EphemeralTarget = SessionActorTarget & {
  database: AgentDatabaseIncognitoIdentity;
};
type ReplicaCell = {
  target: SessionActorTarget;
  snapshot?: SessionActorHotState;
  generation?: string;
  reservation: number;
  handles: number;
  pending: number;
  bytes: number;
};

const MAX_SNAPSHOTS = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const pool = resolveGlobalSingleton(Symbol.for("openclaw.sessionActorReplicas"), () => {
  const cells = new Map<string, ReplicaCell>();
  sessionChanges.subscribeFacts((change) => {
    for (const cell of cells.values()) {
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
      discard(cell);
      forgetUnused(cell);
    }
  });
  return { cells, snapshots: 0, bytes: 0 };
});

function targetKey(target: SessionActorTarget): string {
  const { database, sessionKey } = target;
  return JSON.stringify(
    database.kind === "file"
      ? [database.kind, database.physicalIdentity, database.birthtime, sessionKey]
      : [database.kind, database.handle, database.incarnation, sessionKey],
  );
}

function discard(cell: ReplicaCell): void {
  if (cell.snapshot) {
    pool.snapshots -= 1;
  }
  pool.bytes -= cell.bytes;
  cell.snapshot = undefined;
  cell.generation = undefined;
  cell.bytes = 0;
}

function forgetUnused(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  if (!cell.handles && !cell.pending && !cell.snapshot && pool.cells.get(key) === cell) {
    pool.cells.delete(key);
  }
}

function touch(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  pool.cells.delete(key);
  pool.cells.set(key, cell);
  for (const candidate of pool.cells.values()) {
    if (pool.snapshots <= MAX_SNAPSHOTS && (pool.bytes <= MAX_BYTES || pool.snapshots === 1)) {
      break;
    }
    if (!candidate.snapshot) {
      continue;
    }
    discard(candidate);
    forgetUnused(candidate);
  }
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
