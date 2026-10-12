import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners } from "../../shared/listeners.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import type { PlacementAuthorityOwner, RetainedClaim } from "./placement-turn-authority.types.js";

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
  owner.placementReaders.clear();
  owner.projections.clear();
  owner.preservation = undefined;
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
  const owner: PlacementAuthorityOwner = {
    identity,
    active: true,
    claims: new Map(),
    placements: new Map(),
    observations: new Map(),
    placementReaders: new Map(),
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
