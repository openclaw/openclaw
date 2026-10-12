import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { WorkerSessionPlacementReadResult } from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  ClaimChange,
  PlacementAuthorityOwner,
  RetainedPlacement,
} from "./placement-turn-authority.types.js";

export function hasPendingPublication(owner: PlacementAuthorityOwner, sessionId?: string): boolean {
  return [...owner.pending].some((change) => affectsPlacementObservation(change, sessionId));
}

export function affectsPlacementObservation(change: ClaimChange, sessionId?: string): boolean {
  return (
    change.kind !== "tools" &&
    (sessionId === undefined
      ? change.kind !== "claim" || !change.localOnly
      : change.sessionId === sessionId)
  );
}

/** Install committed postimages without revoking a destination on ordinary turn claims. */
export function applyPlacementReadPublication(
  owner: PlacementAuthorityOwner,
  change: ClaimChange,
  sequence: number,
): void {
  for (const reader of owner.placementReaders.get(change.sessionId) ?? []) {
    if (change.kind === "tools") {
      continue;
    }
    reader.revoked ||= change.indeterminate === true;
    if (sequence <= reader.sequence) {
      continue;
    }
    if (change.kind === "claim") {
      reader.sequence = sequence;
      if (change.retired) {
        reader.placement = undefined;
      } else if (change.workspacePlacement) {
        reader.placement = change.workspacePlacement;
      } else {
        reader.revoked = true;
      }
    } else if (change.kind === "workspace-result" && change.facts) {
      reader.sequence = sequence;
      reader.placement = change.facts.placement;
    } else if (change.kind === "journal" && change.uncertain) {
      reader.revoked = true;
    }
  }
}

export function retainSessionPlacementRead(
  sessionId: string,
  placement: WorkerSessionPlacementRecord | undefined,
  captured: {
    owner: PlacementAuthorityOwner;
    authority: { release: () => void };
    assertUsable: () => void;
  },
) {
  const { owner, authority, assertUsable } = captured;
  const reader: RetainedPlacement = {
    placement: freezeJsonSnapshot(placement),
    sequence: owner.sequence,
    revoked: false,
  };
  const readers = owner.placementReaders.get(sessionId) ?? new Set<RetainedPlacement>();
  readers.add(reader);
  owner.placementReaders.set(sessionId, readers);
  return {
    current(this: void) {
      assertUsable();
      if (reader.revoked || hasPendingPublication(owner, sessionId)) {
        throw new Error(`Session ${sessionId} placement authority changed`);
      }
      return reader.placement;
    },
    release(this: void) {
      readers.delete(reader);
      if (readers.size === 0 && owner.placementReaders.get(sessionId) === readers) {
        owner.placementReaders.delete(sessionId);
      }
      authority.release();
    },
  };
}

type PlacementReadObservation = {
  owner: PlacementAuthorityOwner;
  observation: { revoked: boolean; indeterminate: boolean };
  authority: { assertCurrent: () => void; release: () => void };
  assertUsable: () => void;
};

export function retainProjection(
  owner: PlacementAuthorityOwner,
  sessionId: string,
  projection: WorkerSessionPlacementReadResult,
) {
  owner.projections.delete(sessionId);
  const placement = projection.projection.placements.get(sessionId);
  // Environment lifecycle has its own owner. Keep its changing facts on direct reads.
  if (
    (placement && placement.state !== "local") ||
    projection.projection.environments.size ||
    projection.projection.moves.size ||
    projection.projection.pendingResults.size ||
    projection.projection.workspaceRecoveryPendingSessionIds.size
  ) {
    return;
  }
  owner.projections.set(sessionId, structuredClone(projection));
  // Cold sessions can always rehydrate; residency is independent of durable ownership.
  if (owner.projections.size > 256) {
    owner.projections.delete(owner.projections.keys().next().value!);
  }
}

/** The authority owner retains exact reads until one of its writers publishes a change. */
export async function readCachedPlacementProjection(
  captured: PlacementReadObservation,
  sessionId: string,
  read: () => Promise<WorkerSessionPlacementReadResult>,
): Promise<WorkerSessionPlacementReadResult> {
  const { owner, observation, authority, assertUsable } = captured;
  try {
    const signal = getAsyncWorkSignal();
    signal?.throwIfAborted();
    assertUsable();
    // Snapshot reads must not wait for a delayed receipt from an earlier write.
    const value = hasPendingPublication(owner, sessionId)
      ? await read()
      : (owner.projections.get(sessionId) ?? (await read()));
    signal?.throwIfAborted();
    assertUsable();
    if (!observation.revoked && !hasPendingPublication(owner, sessionId)) {
      retainProjection(owner, sessionId, value);
    }
    return structuredClone(value);
  } finally {
    authority.release();
  }
}

export async function prepareCachedPlacementPreservationRead(
  captured: PlacementReadObservation,
  read: () => Promise<WorkerSessionPlacementRecord[]>,
) {
  return await preparePlacementRead(
    captured,
    undefined,
    async (owner) => owner.preservation ?? (await read()),
    (value, { owner, authority }) => {
      owner.preservation = freezeJsonSnapshot(value);
      return { placements: structuredClone(value), ...authority };
    },
  );
}

export async function preparePlacementRead<T, Result>(
  captured: PlacementReadObservation,
  _sessionId: string | undefined,
  read: (owner: PlacementAuthorityOwner) => Promise<T>,
  consume: (value: T, captured: PlacementReadObservation) => Result,
): Promise<Result> {
  const { authority, owner } = captured;
  const signal = getAsyncWorkSignal();
  try {
    signal?.throwIfAborted();
    const value = await read(owner);
    signal?.throwIfAborted();
    authority.assertCurrent();
    return consume(value, captured);
  } catch (error) {
    authority.release();
    throw error;
  }
}
