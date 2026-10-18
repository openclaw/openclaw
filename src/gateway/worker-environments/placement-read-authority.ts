import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  WorkerPlacementRecoveryCandidate,
  WorkerSessionPlacementReadResult,
} from "./placement-read-projection.types.js";
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
  if (change.kind === "tools") {
    return false;
  }
  if (sessionId !== undefined) {
    return change.sessionId === sessionId;
  }
  // Turn, ACK, result, and journal bookkeeping leave preservation ownership unchanged.
  return change.kind === "claim"
    ? !change.localOnly && (!change.inventoryUnchanged || change.indeterminate === true)
    : change.indeterminate === true;
}

export function prunePublication(owner: PlacementAuthorityOwner, sessionId: string): void {
  if (
    !owner.claims.has(sessionId) &&
    !owner.workspaceResults.has(sessionId) &&
    !owner.observations.has(sessionId) &&
    !owner.placementReaders.has(sessionId) &&
    ![...owner.pending].some((change) => change.sessionId === sessionId)
  ) {
    owner.published.delete(sessionId);
    if (!owner.tools.get(sessionId)?.authority) {
      owner.tools.delete(sessionId);
    }
  }
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
  const published = owner.placements.get(sessionId);
  const reader: RetainedPlacement = {
    placement: freezeJsonSnapshot(published ? published.placement : placement),
    sequence: owner.sequence,
    revoked: false,
  };
  const readers = owner.placementReaders.get(sessionId) ?? new Set<RetainedPlacement>();
  readers.add(reader);
  owner.placementReaders.set(sessionId, readers);
  return {
    prepareRead(this: void): Promise<void> | undefined {
      assertUsable();
      const pending = [...owner.pending].filter(
        (change): change is Extract<ClaimChange, { kind: "claim" }> =>
          change.kind === "claim" && change.sessionId === sessionId,
      );
      const settlements = pending.flatMap((change) =>
        change.nativeSettlement ? [change.nativeSettlement] : [],
      );
      if (
        reader.revoked ||
        pending.some((change) => change.indeterminate) ||
        settlements.length !== pending.length
      ) {
        throw new Error(`Session ${sessionId} placement authority changed`);
      }
      if (settlements.length === 0) {
        return undefined;
      }
      // Join the existing native owner; callers must release synchronous readers first.
      return Promise.all(settlements).then((outcomes) => {
        assertUsable();
        if (reader.revoked) {
          throw new Error(`Session ${sessionId} placement authority changed`);
        }
        for (const outcome of outcomes) {
          if (outcome.kind !== "completed") {
            throw outcome.error;
          }
        }
      });
    },
    current(this: void) {
      assertUsable();
      // Result, ACK, and journal writes leave this read's execution target unchanged.
      if (
        reader.revoked ||
        [...owner.pending].some(
          (change) => change.kind === "claim" && change.sessionId === sessionId,
        )
      ) {
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
  observation: { revokedBy: Set<string>; indeterminate: boolean };
  authority: { assertCurrent: () => void; release: () => void };
  assertUsable: () => void;
};

export function retainProjection(
  owner: PlacementAuthorityOwner,
  sessionId: string,
  projection: WorkerSessionPlacementReadResult,
) {
  const retained = owner.projections.get(sessionId);
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
  owner.projections.set(
    sessionId,
    retained === projection ? projection : structuredClone(projection),
  );
  // Cold sessions can always rehydrate; residency is independent of durable ownership.
  if (owner.projections.size > 256) {
    owner.projections.delete(owner.projections.keys().next().value!);
  }
}

/** Local claim writes change only placement; the owner retains the other projection facts. */
export function projectCachedLocalPlacementTurnClaim(
  owner: PlacementAuthorityOwner | undefined,
  placement: WorkerSessionPlacementRecord,
): WorkerSessionPlacementReadResult["projection"] | undefined {
  if (
    !owner?.active ||
    placement.state !== "local" ||
    hasPendingPublication(owner, placement.sessionId)
  ) {
    return undefined;
  }
  const retained = owner.projections.get(placement.sessionId);
  if (!retained) {
    return undefined;
  }
  return structuredClone({
    ...retained.projection,
    placements: new Map(retained.projection.placements).set(placement.sessionId, placement),
  });
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
    if (observation.revokedBy.size === 0 && !hasPendingPublication(owner, sessionId)) {
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
  const { owner, observation, authority, assertUsable } = captured;
  const sequence = Math.min(
    owner.sequence + 1,
    ...Array.from(owner.pending, (change) => change.sequence ?? owner.sequence + 1),
  );
  const signal = getAsyncWorkSignal();
  try {
    signal?.throwIfAborted();
    assertUsable();
    const baseline = owner.preservation ?? (await read());
    signal?.throwIfAborted();
    assertUsable();
    if (observation.revokedBy.size === 0 && !hasPendingPublication(owner)) {
      owner.preservation = freezeJsonSnapshot(baseline);
    }
    return {
      get placements() {
        assertUsable();
        const placements = new Map(baseline.map((placement) => [placement.sessionId, placement]));
        for (const [sessionId, published] of owner.placements) {
          if (published.sequence < sequence) {
            continue;
          }
          const placement = published.placement;
          if (placement && placement.state !== "local" && placement.state !== "reclaimed") {
            placements.set(sessionId, placement);
          } else {
            placements.delete(sessionId);
          }
        }
        // Pending postimages can add protection, but cannot withdraw committed protection.
        const pending = Array.from(owner.pending).flatMap((change) => {
          const placement =
            change.kind === "claim"
              ? change.workspacePlacement
              : change.kind === "workspace-result"
                ? change.facts?.placement
                : undefined;
          return placement && placement.state !== "local" && placement.state !== "reclaimed"
            ? [placement]
            : [];
        });
        return structuredClone([...placements.values(), ...pending]);
      },
      assertCurrent: assertUsable,
      release: authority.release,
    };
  } catch (error) {
    authority.release();
    throw error;
  }
}

/** Recovery work stays live; empty inventories sleep until a placement writer commits. */
export async function readCachedPlacementRecoveryCandidates(
  captured: PlacementReadObservation,
  read: () => Promise<WorkerPlacementRecoveryCandidate[]>,
): Promise<WorkerPlacementRecoveryCandidate[]> {
  const { owner, observation, authority, assertUsable } = captured;
  try {
    const signal = getAsyncWorkSignal();
    signal?.throwIfAborted();
    assertUsable();
    // Candidate discovery is a snapshot; each recovery effect acquires its exact owner.
    const candidates =
      owner.recoveryCandidatesEmpty && !hasPendingPublication(owner) ? [] : await read();
    signal?.throwIfAborted();
    assertUsable();
    if (
      candidates.length === 0 &&
      observation.revokedBy.size === 0 &&
      !hasPendingPublication(owner)
    ) {
      owner.recoveryCandidatesEmpty = true;
    }
    return candidates;
  } finally {
    authority.release();
  }
}

export async function preparePlacementRead<T, Result>(
  captured: PlacementReadObservation,
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
