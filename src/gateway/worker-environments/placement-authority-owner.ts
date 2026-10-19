import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import {
  isCurrentPlacementTurnClaim,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type {
  ClaimChange,
  PlacementAuthorityOwner,
  RetainedClaim,
} from "./placement-turn-authority.types.js";

export function placementChangeAllowsClaim(
  change: ClaimChange,
  claim: WorkerSessionTurnClaim,
): boolean {
  return (
    change.kind !== "claim" ||
    change.sessionId !== claim.sessionId ||
    Boolean(change.facts && isCurrentPlacementTurnClaim(change.facts, claim))
  );
}

export function notifyPlacementClaimRevoked(claim: RetainedClaim): void {
  if (!claim.revoked) {
    return;
  }
  const listeners = [...claim.listeners];
  claim.listeners.clear();
  notifyListeners(listeners, undefined);
}

export function closePlacementAuthorityOwner(owner: PlacementAuthorityOwner): void {
  owner.active = false;
  owner.changeListeners.clear();
  owner.pending.clear();
  owner.published.clear();
  owner.tools.clear();
  owner.workspaceResults.clear();
  const claims = Array.from(owner.claims.values()).flatMap((retained) => Array.from(retained));
  for (const claim of claims) {
    claim.revoked = true;
  }
  for (const claim of claims) {
    notifyPlacementClaimRevoked(claim);
  }
  owner.claims.clear();
  owner.placements.clear();
  owner.observations.clear();
  owner.projections.clear();
  owner.preservation = undefined;
  owner.recoveryCandidatesEmpty = undefined;
}

export const placementAuthorityOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.placementTurnAuthorities"),
  () => new Map<string, PlacementAuthorityOwner>(),
  (registered) => {
    for (const owner of registered.values()) {
      closePlacementAuthorityOwner(owner);
    }
    registered.clear();
  },
);

export function placementAuthorityOwnerFor(
  identity: DatabasePathIdentity,
): PlacementAuthorityOwner {
  const existing = placementAuthorityOwners.get(identity.key);
  if (existing?.active) {
    return existing;
  }
  if (identity.key.startsWith("file:")) {
    for (const [key, candidate] of placementAuthorityOwners) {
      if (
        candidate.active &&
        key.startsWith("path:") &&
        candidate.identity.canonicalPath === identity.canonicalPath
      ) {
        // First creation preserves readers acquired before the database file existed.
        placementAuthorityOwners.delete(key);
        candidate.identity = identity;
        placementAuthorityOwners.set(identity.key, candidate);
        return candidate;
      }
    }
  }
  const owner: PlacementAuthorityOwner = {
    identity,
    active: true,
    changeListeners: new Set(),
    claims: new Map(),
    placements: new Map(),
    observations: new Map(),
    pending: new Set(),
    sequence: 0,
    published: new Map(),
    tools: new Map(),
    workspaceResults: new Map(),
    projections: new Map(),
  };
  placementAuthorityOwners.set(identity.key, owner);
  return owner;
}

export function subscribePlacementChanges(
  identity: DatabasePathIdentity,
  listener: (placement: WorkerSessionPlacementIdentity) => void,
): () => void {
  return registerListener(placementAuthorityOwnerFor(identity).changeListeners, listener);
}

function changedPlacementIdentity(
  owner: PlacementAuthorityOwner,
  change: ClaimChange,
): WorkerSessionPlacementIdentity | undefined {
  if (change.indeterminate) {
    return undefined;
  }
  if (change.kind === "claim" && change.retired) {
    return change.retiredIdentity;
  }
  const previous = owner.placements.get(change.sessionId)?.placement;
  const current =
    change.kind === "claim"
      ? change.workspacePlacement
      : change.kind === "workspace-result"
        ? change.facts?.placement
        : undefined;
  if (
    current &&
    (!previous ||
      current.state !== previous.state ||
      current.generation !== previous.generation ||
      current.updatedAtMs !== previous.updatedAtMs ||
      current.sessionKey !== previous.sessionKey ||
      current.agentId !== previous.agentId)
  ) {
    return {
      sessionId: current.sessionId,
      sessionKey: current.sessionKey,
      agentId: current.agentId,
    };
  }
  return undefined;
}

export function preparePlacementChangeNotification(
  owner: PlacementAuthorityOwner,
  change: ClaimChange,
): () => void {
  const changed = changedPlacementIdentity(owner, change);
  return () => {
    if (changed) {
      notifyListeners(owner.changeListeners, changed);
    }
  };
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  for (const [key, owner] of placementAuthorityOwners) {
    if (
      key === event.identity?.key ||
      owner.identity.canonicalPath === (event.identity?.canonicalPath ?? event.path)
    ) {
      closePlacementAuthorityOwner(owner);
      placementAuthorityOwners.delete(key);
    }
  }
});
