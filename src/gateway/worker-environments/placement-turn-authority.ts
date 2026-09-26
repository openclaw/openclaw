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

type ClaimChange = {
  sessionId: string;
  facts?: WorkerSessionTurnClaimFacts;
  sequence?: number;
};
type RetainedClaim = {
  claim: WorkerSessionTurnClaim;
  facts?: WorkerSessionTurnClaimFacts;
  createdSequence: number;
  publicationSequence: number;
  revoked: boolean;
  released: boolean;
  listeners: Set<() => void>;
};
type PlacementAuthorityOwner = {
  identity: DatabasePathIdentity;
  active: boolean;
  claims: Map<string, Set<RetainedClaim>>;
  pending: Set<ClaimChange>;
  sequence: number;
  published: Map<string, number>;
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
  owner.published.clear();
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
    sequence: 0,
    published: new Map(),
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

function prunePublication(owner: PlacementAuthorityOwner, sessionId: string): void {
  if (
    !owner.claims.has(sessionId) &&
    ![...owner.pending].some((change) => change.sessionId === sessionId)
  ) {
    owner.published.delete(sessionId);
  }
}

function commitChange(owner: PlacementAuthorityOwner, change: ClaimChange, sequence: number): void {
  owner.pending.delete(change);
  if (!owner.active) {
    return;
  }
  owner.published.set(
    change.sessionId,
    Math.max(owner.published.get(change.sessionId) ?? 0, sequence),
  );
  for (const retained of owner.claims.get(change.sessionId) ?? []) {
    if (sequence <= retained.createdSequence) {
      continue;
    }
    if (sequence > retained.publicationSequence) {
      retained.facts = change.facts;
      retained.publicationSequence = sequence;
    }
    // A delayed release still revokes its old incarnation, even after identical
    // claim bytes were readmitted. It cannot revoke a later prepared incarnation.
    retained.revoked ||= !allows(change, retained.claim);
  }
  prunePublication(owner, change.sessionId);
}

function stageChange(db: DatabaseSync, change: ClaimChange): void {
  const owner = ownerFor(requireOpenClawStateDatabaseIdentity({ db }));
  if (
    !stageSqliteTransactionState(db, {
      stage() {
        owner.pending.add(change);
      },
      commit() {
        commitChange(owner, change, ++owner.sequence);
      },
      prepareObservers() {
        for (const retained of Array.from(owner.claims.get(change.sessionId) ?? [])) {
          notifyRevoked(retained);
        }
      },
      rollback() {
        owner.pending.delete(change);
        prunePublication(owner, change.sessionId);
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

/** Fence host authority before granting the worker's commit; settle only its exact receipt. */
export function stagePlacementTurnClaimWorkerPublication(
  identity: DatabasePathIdentity,
  facts: WorkerSessionTurnClaimFacts,
): { commit: () => void; rollback: () => void } {
  const owner = ownerFor(identity);
  const sequence = ++owner.sequence;
  const change: ClaimChange = {
    sessionId: facts.sessionId,
    facts: structuredClone(facts),
    sequence,
  };
  owner.pending.add(change);
  let settled = false;
  return {
    commit() {
      if (settled) {
        return;
      }
      settled = true;
      commitChange(owner, change, sequence);
      for (const retained of Array.from(owner.claims.get(change.sessionId) ?? [])) {
        notifyRevoked(retained);
      }
    },
    rollback() {
      if (settled) {
        return;
      }
      settled = true;
      owner.pending.delete(change);
      prunePublication(owner, change.sessionId);
    },
  };
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
    createdSequence: owner.published.get(claim.sessionId) ?? 0,
    publicationSequence: owner.published.get(claim.sessionId) ?? 0,
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
    prunePublication(owner, claim.sessionId);
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
      if (
        (change.sequence === undefined || change.sequence > retained.createdSequence) &&
        !allows(change, claim)
      ) {
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
