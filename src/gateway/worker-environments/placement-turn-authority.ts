import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  isCurrentPlacementTurnClaim,
  required,
  type WorkerSessionTurnClaim,
  type WorkerSessionTurnClaimFacts,
} from "./placement-record.js";

export type PlacementTurnClaimAuthority = {
  readonly claim: WorkerSessionTurnClaim;
  readonly identity: Readonly<{ agentId: string; sessionKey: string }>;
  isCurrent: () => boolean;
  onRevoked: (listener: () => void) => () => void;
  release: () => void;
};

type ClaimChange = { sessionId: string; facts?: WorkerSessionTurnClaimFacts };
type RetainedClaim = {
  claim: WorkerSessionTurnClaim;
  facts?: WorkerSessionTurnClaimFacts;
  revoked: boolean;
  released: boolean;
  listeners: Set<() => void>;
};
type PlacementAuthorityOwner = {
  identity: DatabasePathIdentity;
  active: boolean;
  claims: Map<string, Set<RetainedClaim>>;
  pending: Set<ClaimChange>;
};

function notifyRevoked(claim: RetainedClaim): void {
  if (!claim.revoked) {
    return;
  }
  const listeners = [...claim.listeners];
  claim.listeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Cleanup observers cannot undo the authoritative revocation.
    }
  }
}

function closeOwner(owner: PlacementAuthorityOwner): void {
  owner.active = false;
  owner.pending.clear();
  const claims = Array.from(owner.claims.values()).flatMap((retained) => Array.from(retained));
  for (const claim of claims) {
    claim.revoked = true;
  }
  for (const claim of claims) {
    notifyRevoked(claim);
  }
  owner.claims.clear();
}

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.placementTurnAuthorities"),
  () => new Map<string, PlacementAuthorityOwner>(),
  (registered) => {
    for (const owner of registered.values()) {
      closeOwner(owner);
    }
    registered.clear();
  },
);

function ownerFor(identity: DatabasePathIdentity): PlacementAuthorityOwner {
  const existing = owners.get(identity.key);
  if (existing?.active) {
    return existing;
  }
  const owner: PlacementAuthorityOwner = {
    identity,
    active: true,
    claims: new Map(),
    pending: new Set(),
  };
  owners.set(identity.key, owner);
  return owner;
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  for (const [key, owner] of owners) {
    if (
      key === event.identity?.key ||
      owner.identity.canonicalPath === (event.identity?.canonicalPath ?? event.path)
    ) {
      closeOwner(owner);
      owners.delete(key);
    }
  }
});

function allows(change: ClaimChange, claim: WorkerSessionTurnClaim): boolean {
  return (
    change.sessionId !== claim.sessionId ||
    Boolean(change.facts && isCurrentPlacementTurnClaim(change.facts, claim))
  );
}

function stageChange(db: DatabaseSync, change: ClaimChange): void {
  const owner = ownerFor(requireOpenClawStateDatabaseIdentity({ db }));
  if (
    !stageSqliteTransactionState(db, {
      stage() {
        owner.pending.add(change);
      },
      commit() {
        owner.pending.delete(change);
        for (const retained of owner.claims.get(change.sessionId) ?? []) {
          retained.facts = change.facts;
          retained.revoked ||= !allows(change, retained.claim);
        }
      },
      prepareObservers() {
        for (const retained of Array.from(owner.claims.get(change.sessionId) ?? [])) {
          notifyRevoked(retained);
        }
      },
      rollback() {
        owner.pending.delete(change);
        try {
          assertTransactionUsable(db);
        } catch {
          // A lost commit/rollback cannot restore an earlier live claim.
          closeOwner(owner);
        }
      },
    })
  ) {
    throw new Error("Placement authority publication requires its owning transaction");
  }
}

/** Publish only an existing successful writer postimage; this performs no database read. */
export function publishPlacementTurnClaimState(
  db: DatabaseSync,
  record: WorkerSessionTurnClaimFacts,
): void {
  const { sessionId, agentId, sessionKey, state, executionMode, environmentId, activeOwnerEpoch } =
    record;
  stageChange(db, {
    sessionId,
    facts: {
      sessionId,
      agentId,
      sessionKey,
      state,
      executionMode,
      environmentId,
      activeOwnerEpoch,
      turnClaim: record.turnClaim ? { ...record.turnClaim } : null,
    },
  });
}

export function publishPlacementTurnClaimCleared(db: DatabaseSync, sessionId: string): void {
  stageChange(db, { sessionId });
}

/** Prepare once through the placement reader; subsequent checks use this retained incarnation. */
export async function preparePlacementTurnClaimAuthority(
  pathname: string,
  requestedClaim: WorkerSessionTurnClaim,
  read: (
    sessionIds: readonly string[],
  ) => Promise<{ placements: ReadonlyMap<string, WorkerSessionTurnClaimFacts> }>,
): Promise<PlacementTurnClaimAuthority> {
  const context = captureOpenClawStateWorkerContext({ path: pathname });
  const owner = ownerFor(context.admission.identity);
  const claim = structuredClone(requestedClaim);
  claim.sessionId = required(claim.sessionId, "session id");
  Object.freeze(claim.owner);
  Object.freeze(claim);
  const retained: RetainedClaim = {
    claim,
    revoked: false,
    released: false,
    listeners: new Set(),
  };
  const claims = owner.claims.get(claim.sessionId) ?? new Set<RetainedClaim>();
  claims.add(retained);
  owner.claims.set(claim.sessionId, claims);
  const release = () => {
    retained.released = true;
    retained.listeners.clear();
    claims.delete(retained);
    if (claims.size === 0 && owner.claims.get(claim.sessionId) === claims) {
      owner.claims.delete(claim.sessionId);
    }
  };
  const isCurrent = () => {
    if (
      retained.released ||
      retained.revoked ||
      !owner.active ||
      owners.get(owner.identity.key) !== owner ||
      !retained.facts ||
      !isCurrentPlacementTurnClaim(retained.facts, claim)
    ) {
      return false;
    }
    for (const change of owner.pending) {
      if (!allows(change, claim)) {
        return false;
      }
    }
    try {
      context.admission.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error(`Session ${claim.sessionId} turn claim authority changed`);
    }
  };
  try {
    const projection = await read([claim.sessionId]);
    context.admission.assertCurrent();
    // Committed publications received during the read supersede its older snapshot.
    retained.facts ??= projection.placements.get(claim.sessionId);
    assertCurrent();
    const facts = retained.facts;
    if (!facts) {
      throw new Error(`Session ${claim.sessionId} turn claim is unavailable`);
    }
    return {
      claim,
      identity: Object.freeze({
        agentId: facts.agentId,
        sessionKey: facts.sessionKey,
      }),
      isCurrent,
      onRevoked(listener) {
        if (retained.revoked || !owner.active) {
          listener();
          return () => {};
        }
        retained.listeners.add(listener);
        return () => retained.listeners.delete(listener);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
