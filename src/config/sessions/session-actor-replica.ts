import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sessionChangeAffectsStoredRow } from "../../sessions/session-row-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionEntryPublicationSource,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type {
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorTarget,
} from "./session-actor-contract.js";
import {
  readSessionActorParticipantPostimage,
  readSessionActorProjectionReceiptFromCells,
  scopedWriteToken,
} from "./session-actor-replica-receipts.js";
import type {
  FileTarget,
  ReplicaCell,
  ReplicaPool,
  SessionActorEntryFacts,
} from "./session-actor-replica.types.js";
import { readSessionActorTranscriptAnchors } from "./session-actor-transcript-anchors.js";
import {
  advanceSessionActorTranscriptReplica,
  rewriteSessionActorTranscriptReplica,
  sameSessionActorTranscriptVersion,
  type SessionActorTranscriptReplica,
} from "./session-actor-transcript-replica.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import { readPreparedSessionTranscriptChange } from "./session-transcript-authority.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

const MAX_SNAPSHOTS = 128;
const MAX_BYTES = 8 * 1024 * 1024;

// Residency is a heap estimate, not a wire-size limit. Trusted postimages are
// acyclic plain data; count strings without allocating or scanning their JSON.
function estimateReplicaBytes(value: unknown): number {
  if (typeof value === "string") {
    return 16 + value.length * 2;
  }
  if (!value || typeof value !== "object") {
    return 8;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((bytes, child) => bytes + 16 + estimateReplicaBytes(child), 32);
  }
  let bytes = 32;
  for (const key in value) {
    bytes += 16 + key.length * 2 + estimateReplicaBytes(Reflect.get(value, key));
  }
  return bytes;
}

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

export function ensureReplicaSubscription(): void {
  if (pool.unsubscribe) {
    return;
  }
  // Lifecycle cleanup also clears listeners; subscribe only when this owner resumes.
  pool.unsubscribe = sessionChanges.subscribeFacts((change) => {
    // Receipt installation reorders the LRU map, so visit the original cells once.
    const cellsBeforePublication = [...pool.cells.values()];
    const publishedKey =
      !("all" in change) && !change.factsInvalidated ? change.sessionKey : undefined;
    const created = publishedKey ? readPreparedSessionEntryChange(change, publishedKey) : undefined;
    if (publishedKey && created?.fullEntry && typeof created.source.identity === "string") {
      const target: FileTarget = {
        sessionKey: publishedKey,
        database: {
          kind: "file",
          physicalIdentity: created.source.identity,
          birthtime: created.source.birthtime,
          nativeLocation: created.source.canonicalPath ?? created.source.filename,
        },
      };
      if (
        !pool.cells.has(targetKey(target)) &&
        created.source.writeToken ===
          readSqliteDatabaseWriteTokenForPath(target.database.nativeLocation)
      ) {
        // Creation already owns the complete entry; its first reader need not fetch it again.
        retainSessionActorEntryFacts(
          target,
          { entry: created.fullEntry, snapshots: "full", projection: created.projection },
          created.source.incarnation,
        );
      }
    }
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
      // Board writes use unchanged-entry markers, so they revoke row projection coverage.
      const unchangedEntry =
        unchangedMarker && cell.entry ? { ...cell.entry, projection: undefined } : undefined;
      const previousTranscript = cell.transcript;
      const participantPostimage = readSessionActorParticipantPostimage(
        { database, sessionKey },
        cell.snapshot,
        change,
      );
      const previous = cell.snapshot ?? cell.entry;
      const previousProjection = cell.snapshot
        ? { hasBoard: cell.snapshot.hasBoard }
        : cell.entry?.projection;
      discard(cell);
      if (participantPostimage) {
        retainSnapshot(cell, participantPostimage, cell.generation);
        if (previousTranscript) {
          retainTranscript(cell, previousTranscript);
        }
        continue;
      }
      const transcript = readPreparedSessionTranscriptChange(change);
      const rewrite =
        publishedKey === sessionKey && transcript?.kind === "postimage"
          ? transcript.value.actorRewrite
          : undefined;
      if (
        rewrite &&
        source.identity === database.physicalIdentity &&
        rewrite.postimage.writeToken ===
          scopedWriteToken({ database, sessionKey }, rewrite.postimage.dependencySessionIds)
      ) {
        retainSnapshot(cell, rewrite.postimage, cell.generation);
        const retained = rewriteSessionActorTranscriptReplica(previousTranscript, rewrite);
        if (retained) {
          retainTranscript(cell, retained);
        }
        continue;
      }
      if (
        !("all" in change) &&
        !change.factsInvalidated &&
        change.facts?.kind === "participants" &&
        previousTranscript
      ) {
        // Keep payloads private until a fresh actor snapshot confirms their transcript version.
        retainTranscript(cell, previousTranscript);
      }
      if (unchangedEntry) {
        // Transcript/metadata markers do not revoke an installed entry receipt.
        // Its original scoped token still rejects any unaccounted storage write.
        cell.entry = unchangedEntry;
        cell.bytes = estimateReplicaBytes(unchangedEntry);
        pool.snapshots += 1;
        pool.bytes += cell.bytes;
      }
      if (
        prepared &&
        source.identity === database.physicalIdentity &&
        prepared.source.writeToken === readSqliteDatabaseWriteTokenForPath(database.nativeLocation)
      ) {
        if (prepared.actorPostimage) {
          retainSnapshot(cell, prepared.actorPostimage, prepared.source.incarnation);
          if (
            previousTranscript &&
            previousTranscript.sessionId === prepared.actorPostimage.entry?.sessionId &&
            sameSessionActorTranscriptVersion(
              previousTranscript.version,
              prepared.actorPostimage.transcript.version,
            )
          ) {
            retainTranscript(cell, previousTranscript);
          }
          continue;
        }
        if (!prepared.fullEntry) {
          forgetUnused(cell);
          continue;
        }
        const dependencySessionIds = [prepared.fullEntry.sessionId];
        const writeToken = scopedWriteToken({ database, sessionKey }, dependencySessionIds);
        if (writeToken) {
          const projection =
            prepared.projection ??
            (previous?.entry?.sessionId === prepared.fullEntry.sessionId &&
            previous.entry.lifecycleRevision === prepared.fullEntry.lifecycleRevision &&
            previousProjection
              ? { hasBoard: previousProjection.hasBoard }
              : undefined);
          // Metadata receipts retain side-table facts when their writer did not change sharing.
          const sharingUnchanged = readPreparedSessionSharingChange(change) === "unchanged";
          cell.entry = freezeJsonSnapshot({
            target: cell.target,
            entry: structuredClone(prepared.fullEntry),
            dependencySessionIds,
            writeToken,
            snapshots: "full",
            projection,
            members: sharingUnchanged ? previous?.members : undefined,
            participants: sharingUnchanged ? previous?.participants : undefined,
          });
          cell.bytes = estimateReplicaBytes(cell.entry);
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
  if (cell.snapshot || cell.entry || cell.transcript) {
    pool.snapshots -= 1;
  }
  pool.bytes -= cell.bytes;
  cell.transcript = undefined;
  cell.snapshot = undefined;
  cell.entry = undefined;
  cell.bytes = 0;
}

function retainSnapshot(
  cell: ReplicaCell,
  state: SessionActorHotState,
  generation: string | undefined,
): void {
  if (cell.snapshot === state && cell.generation === generation) {
    return touch(cell);
  }
  const previousTranscript = cell.transcript;
  discard(cell);
  cell.snapshot = state;
  cell.generation = generation;
  cell.bytes = estimateReplicaBytes(state);
  pool.snapshots += 1;
  pool.bytes += cell.bytes;
  if (
    previousTranscript &&
    previousTranscript.sessionId === state.entry?.sessionId &&
    sameSessionActorTranscriptVersion(previousTranscript.version, state.transcript.version)
  ) {
    retainTranscript(cell, previousTranscript);
  }
  touch(cell);
}

function retainTranscript(cell: ReplicaCell, transcript: SessionActorTranscriptReplica): void {
  if (!cell.snapshot && !cell.entry && !cell.transcript) {
    pool.snapshots += 1;
  }
  const previousBytes = cell.transcript ? estimateReplicaBytes(cell.transcript) : 0;
  const bytes = estimateReplicaBytes(transcript);
  cell.transcript = transcript;
  cell.bytes += bytes - previousBytes;
  pool.bytes += bytes - previousBytes;
  touch(cell);
}

/** The caller already borrowed this immutable postimage under its live actor authority. */
export function readSessionActorTranscriptReplica(
  state: SessionActorHotState,
): SessionActorTranscriptReplica | undefined {
  const cell = pool.cells.get(targetKey(state.target));
  return cell?.snapshot?.writeToken === state.writeToken ? cell.transcript : undefined;
}

export function retainSessionActorTranscriptReplica(
  state: SessionActorHotState,
  transcript: SessionActorTranscriptReplica,
): void {
  const cell = pool.cells.get(targetKey(state.target));
  if (cell?.snapshot?.writeToken === state.writeToken) {
    retainTranscript(cell, transcript);
  }
}

function forgetUnused(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  const empty = !cell.snapshot && !cell.entry && !cell.transcript;
  if (!cell.handles && !cell.pending && empty && pool.cells.get(key) === cell) {
    pool.cells.delete(key);
  }
}

function touch(cell: ReplicaCell): void {
  const key = targetKey(cell.target);
  pool.cells.delete(key);
  pool.cells.set(key, cell);
  for (const candidate of pool.cells.values()) {
    if (!candidate.snapshot && !candidate.entry && !candidate.transcript) {
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

export function readSessionActorProjectionReceipt(
  params: Pick<SessionTranscriptProjectionReceipt, "path" | "sessionId"> & { sessionKey?: string },
): SessionTranscriptProjectionReceipt | undefined {
  return readSessionActorProjectionReceiptFromCells(pool.cells.values(), touch, params);
}

function readCurrentEntryCell(target: FileTarget, admitted?: DatabasePathIdentity) {
  ensureReplicaSubscription();
  const cell = pool.cells.get(targetKey(target));
  const state = cell?.snapshot ?? cell?.entry;
  if (!cell || !state || cell.generation === undefined) {
    return undefined;
  }
  const current = admitted ?? readDatabasePathIdentitySync(target.database.nativeLocation);
  const token = scopedWriteToken(target, state.dependencySessionIds);
  if (
    current.key !== `file:${target.database.physicalIdentity}` ||
    current.birthtime !== target.database.birthtime ||
    (token && token !== state.writeToken)
  ) {
    discard(cell);
    forgetUnused(cell);
    return undefined;
  }
  if (token) {
    touch(cell);
  }
  return token ? { cell, state, incarnation: cell.generation } : undefined;
}

/** Entry projections share actor residency; they never certify live authority. */
export function readSessionActorEntryFacts(
  target: FileTarget,
  snapshotFields: SessionActorEntryFacts["snapshots"] = "full",
): (SessionActorEntryFacts & { incarnation: string }) | undefined {
  const current = readCurrentEntryCell(target);
  if (!current) {
    return undefined;
  }
  const { cell, state, incarnation } = current;
  const snapshots = cell.snapshot ? "full" : (cell.entry?.snapshots ?? "full");
  // Project a shallow shell before cloning potentially large, unrequested snapshots.
  return structuredClone({
    target,
    entry:
      state.entry && snapshotFields !== "full"
        ? attachSessionEntrySnapshots({ ...state.entry }, {}, snapshotFields)
        : state.entry,
    members: state.members,
    participants: state.participants,
    coldArchiveAbsent:
      cell.snapshot?.transcript.modelContext.kind === "resident" ||
      cell.snapshot?.transcript.modelContext.reason === "projection",
    snapshots:
      snapshotFields === "full"
        ? snapshots
        : snapshotFields.filter((field) => snapshots === "full" || snapshots.includes(field)),
    projection: cell.snapshot
      ? {
          hasBoard: cell.snapshot.hasBoard,
          activitySummaryWatermark: cell.snapshot.transcript.watermark,
        }
      : cell.entry?.projection,
    dependencySessionIds: state.dependencySessionIds,
    writeToken: state.writeToken,
    incarnation,
  });
}

function readCurrentEntryCellForPath(
  params: { path: string; sessionKey: string },
  admitted?: DatabasePathIdentity,
) {
  ensureReplicaSubscription();
  for (const { target } of pool.cells.values()) {
    const { database, sessionKey } = target;
    if (
      database.kind === "file" &&
      database.nativeLocation === params.path &&
      sessionKey === params.sessionKey
    ) {
      return readCurrentEntryCell({ database, sessionKey }, admitted);
    }
  }
  return undefined;
}

/** Only the complete actor postimage covers pending-input absence for its current window. */
export function hasSessionActorEmptyPendingInputHistory(
  admitted: DatabasePathIdentity,
  sessionKey: string,
  sessionId: string,
): boolean {
  const snapshot = readCurrentEntryCellForPath(
    { path: admitted.canonicalPath, sessionKey },
    admitted,
  )?.cell.snapshot;
  return (
    snapshot?.entry?.sessionId === sessionId &&
    snapshot.pendingInputs.every((row) => row.consumed_event_id !== null)
  );
}

/** Complete transcript bodies share the actor's receipt token and bounded residency. */
export function readSessionActorCompleteTranscriptFromReplica(params: {
  path: string;
  sessionKey: string;
  sessionId: string;
}) {
  const current = readCurrentEntryCellForPath(params);
  const snapshot = current?.cell.snapshot;
  const context = current?.cell.transcript?.context;
  return snapshot?.entry?.sessionId === params.sessionId && context?.rows
    ? {
        snapshot,
        rows: context.rows,
        activeLeafEntryId: context.activeLeafEntryId,
      }
    : undefined;
}

/** Recorded transcript facts survive actor release; delivery authority stays with the caller. */
export function readSessionActorTranscriptAnchorsFromReplica(
  params: { path: string; sessionKey: string; sessionId: string; agentId: string },
  selection: SessionTranscriptAnchorSelection,
) {
  const current = readCurrentEntryCellForPath(params);
  const snapshot = current?.cell.snapshot;
  return snapshot && snapshot.entry?.sessionId === params.sessionId
    ? readSessionActorTranscriptAnchors(snapshot, params, selection, current?.cell.transcript?.tail)
    : undefined;
}

/** Reuse complete actor facts before requesting the same row from the history worker. */
export function readSessionActorRowFacts(params: {
  path: string;
  sessionKey: string;
}): SessionRowDatabaseFacts | undefined {
  const current = readCurrentEntryCellForPath(params);
  const state = current?.state;
  const projection = current?.cell.snapshot
    ? {
        hasBoard: current.cell.snapshot.hasBoard,
        activitySummaryWatermark: current.cell.snapshot.transcript.watermark,
      }
    : current?.cell.entry?.projection;
  if (!state?.entry || !projection) {
    return undefined;
  }
  const summary = readSessionActivitySummary(state.entry);
  if (summary && !projection.activitySummaryWatermark) {
    return undefined;
  }
  return structuredClone({
    sessionKey: params.sessionKey,
    entry: attachSessionEntrySnapshots({ ...state.entry }, {}, "list"),
    hasBoard: projection.hasBoard,
    ...(summary ? { activitySummaryWatermark: projection.activitySummaryWatermark } : {}),
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
  const writeToken = scopedWriteToken(target, dependencySessionIds);
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
    const current = scopedWriteToken(target, cell.snapshot.dependencySessionIds);
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
  cell.bytes = estimateReplicaBytes(cell.entry);
  pool.snapshots += 1;
  pool.bytes += cell.bytes;
  touch(cell);
}

/** Handles retain their own authority; complete physical postimages survive handle release. */
export function createSessionActorReplica(params: {
  lifetime: SessionActorLifetime;
  target: FileTarget;
  currentGeneration: () => string | undefined;
}) {
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
      return params.currentGeneration();
    } catch {
      return undefined;
    }
  };
  const currentToken = (state: SessionActorHotState): string | undefined => {
    const { database, sessionKey } = target;
    try {
      const identity = readDatabasePathIdentitySync(database.nativeLocation);
      if (
        identity.key !== `file:${database.physicalIdentity}` ||
        (database.birthtime !== undefined && identity.birthtime !== database.birthtime)
      ) {
        return undefined;
      }
      return scopedWriteToken({ database, sessionKey }, state.dependencySessionIds);
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
    if (!accepts(state, expectedGeneration)) {
      discard(owned);
      return false;
    }
    retainSnapshot(owned, state, expectedGeneration);
    return owned.snapshot !== undefined;
  };
  const begin = () => {
    params.lifetime.assertCurrent();
    if (closed) {
      throw new Error("Session actor replica is closed");
    }
    owned.pending += 1;
    owned.reservation += 1;
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
    /** Borrow the immutable revision only after validating its current physical generation. */
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
        discard(owned);
        forgetUnused(owned);
        return undefined;
      }
      touch(owned);
      return owned.snapshot;
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
      const previousTranscript = owned.transcript;
      const previousGeneration = owned.generation;
      const settle = begin();
      return {
        settle<Value>(outcome: SessionActorOutcome<Value>): boolean {
          return settle((expectedGeneration) => {
            if (outcome.kind === "rolled-back") {
              const restored = previous !== undefined && install(previous, previousGeneration);
              if (restored && previousTranscript) {
                retainTranscript(owned, previousTranscript);
              }
              return restored;
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
            const installed = install(outcome.receipt.postimage, expectedGeneration);
            if (installed) {
              retainTranscript(
                owned,
                advanceSessionActorTranscriptReplica(previousTranscript, outcome),
              );
            }
            return installed;
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
