import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
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
