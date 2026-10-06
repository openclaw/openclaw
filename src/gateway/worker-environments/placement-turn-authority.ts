import type { DatabaseSync } from "node:sqlite";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  isCurrentPlacementTurnClaim,
  sameWorkerSessionTurnClaim,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
  type WorkerSessionTurnClaimFacts,
} from "./placement-record.js";
import {
  isCurrentWorkerWorkspacePendingResultOwner,
  matchesWorkspaceResultClaim,
} from "./placement-workspace-result-owner.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

export type PlacementTurnClaimAuthority = {
  readonly claim: WorkerSessionTurnClaim;
  readonly identity: Readonly<{ agentId: string; sessionKey: string }>;
  isCurrent: () => boolean;
  onRevoked: (listener: () => void) => () => void;
  release: () => void;
};

type ClaimChange = {
  sessionId: string;
  sequence?: number;
  indeterminate?: true;
} & (
  | {
      kind: "claim";
      facts?: WorkerSessionTurnClaimFacts;
      workspaceResult?: WorkspaceResultPostimage;
      workspacePlacement?: WorkerSessionPlacementRecord;
    }
  | { kind: "workspace-result"; facts?: WorkspaceResultPostimage }
  | { kind: "journal"; uncertain?: true }
  | { kind: "tools"; claimId: string; authority?: ToolAuthority }
);
type WorkspaceResultPostimage = {
  placement: WorkerSessionPlacementRecord;
  pendingResult: WorkerWorkspacePendingResult | undefined;
};
type WorkspaceResultFacts = WorkspaceResultPostimage & {
  pendingResult: WorkerWorkspacePendingResult;
};
type ToolAuthority = { claim: WorkerSessionTurnClaim; toolNames: readonly string[] };
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
  observations: Map<string | undefined, Set<{ revoked: boolean; indeterminate: boolean }>>;
  pending: Set<ClaimChange>;
  settlementListeners: Set<() => void>;
  sequence: number;
  published: Map<string, number>;
  tools: Map<string, { sequence: number; authority?: ToolAuthority }>;
  workspaceResults: Map<string, WorkspaceResultFacts>;
};

function notifySettlement(owner: PlacementAuthorityOwner): void {
  owner.settlementListeners.forEach((listener) => listener());
}

function hasPendingPublication(owner: PlacementAuthorityOwner, sessionId?: string): boolean {
  return [...owner.pending].some(
    (change) =>
      change.kind !== "tools" && (sessionId === undefined || change.sessionId === sessionId),
  );
}

function notifyRevoked(claim: RetainedClaim): void {
  if (!claim.revoked) {
    return;
  }
  const listeners = [...claim.listeners];
  claim.listeners.clear();
  notifyListeners(listeners, undefined);
}

function closeOwner(owner: PlacementAuthorityOwner): void {
  owner.active = false;
  owner.pending.clear();
  notifySettlement(owner);
  owner.settlementListeners.clear();
  owner.published.clear();
  owner.tools.clear();
  owner.workspaceResults.clear();
  const claims = Array.from(owner.claims.values()).flatMap((retained) => Array.from(retained));
  for (const claim of claims) {
    claim.revoked = true;
  }
  for (const claim of claims) {
    notifyRevoked(claim);
  }
  owner.claims.clear();
  owner.observations.clear();
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
    observations: new Map(),
    pending: new Set(),
    settlementListeners: new Set(),
    sequence: 0,
    published: new Map(),
    tools: new Map(),
    workspaceResults: new Map(),
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
    change.kind !== "claim" ||
    change.sessionId !== claim.sessionId ||
    Boolean(change.facts && isCurrentPlacementTurnClaim(change.facts, claim))
  );
}

function prunePublication(owner: PlacementAuthorityOwner, sessionId: string): void {
  if (
    !owner.claims.has(sessionId) &&
    !owner.workspaceResults.has(sessionId) &&
    !owner.observations.has(sessionId) &&
    ![...owner.pending].some((change) => change.sessionId === sessionId)
  ) {
    owner.published.delete(sessionId);
    if (!owner.tools.get(sessionId)?.authority) {
      owner.tools.delete(sessionId);
    }
  }
}

function commitChange(owner: PlacementAuthorityOwner, change: ClaimChange, sequence: number): void {
  owner.pending.delete(change);
  notifySettlement(owner);
  if (!owner.active) {
    return;
  }
  const tools = owner.tools.get(change.sessionId);
  if (change.kind === "tools") {
    if (sequence > (tools?.sequence ?? -1)) {
      const authority = change.authority;
      if (!tools?.authority || authority || tools.authority.claim.claimId === change.claimId) {
        owner.tools.set(change.sessionId, { sequence, authority });
      }
    }
    prunePublication(owner, change.sessionId);
    return;
  }
  for (const observation of [
    ...(owner.observations.get(change.sessionId) ?? []),
    ...(owner.observations.get(undefined) ?? []),
  ]) {
    observation.revoked = true;
    observation.indeterminate ||= change.indeterminate === true;
  }
  if (sequence > (owner.published.get(change.sessionId) ?? -1)) {
    const result =
      change.kind === "workspace-result"
        ? change.facts
        : change.kind === "claim"
          ? change.workspaceResult
          : undefined;
    const placement = change.kind === "claim" ? change.workspacePlacement : undefined;
    const retained = owner.workspaceResults.get(change.sessionId);
    if (change.kind === "journal" && !change.uncertain) {
      // Journal-only commits leave the exact placement and pending result unchanged.
    } else if (result?.pendingResult) {
      owner.workspaceResults.set(
        change.sessionId,
        Object.freeze({
          placement: result.placement,
          pendingResult: result.pendingResult,
        }),
      );
    } else if (
      !result &&
      placement &&
      retained &&
      isCurrentWorkerWorkspacePendingResultOwner(placement, retained.pendingResult)
    ) {
      // Drain keeps exact result custody. Read at commit so earlier clears stay cleared.
      owner.workspaceResults.set(
        change.sessionId,
        Object.freeze({
          placement,
          pendingResult: retained.pendingResult,
        }),
      );
    } else {
      // Native writers without a complete postimage cannot preserve prepared custody.
      owner.workspaceResults.delete(change.sessionId);
    }
    owner.published.set(change.sessionId, sequence);
  }
  if (change.kind !== "claim") {
    prunePublication(owner, change.sessionId);
    return;
  }
  const facts = change.facts;
  if (
    sequence > (tools?.sequence ?? -1) &&
    (!facts?.turnClaim ||
      (tools?.authority && !isCurrentPlacementTurnClaim(facts, tools.authority.claim)) ||
      [...owner.pending].some(
        (pending) =>
          pending.sessionId === change.sessionId &&
          pending.kind === "tools" &&
          pending.authority &&
          !isCurrentPlacementTurnClaim(facts, pending.authority.claim),
      ))
  ) {
    owner.tools.set(change.sessionId, { sequence });
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

function capturePlacementObservation(pathname: string, sessionId?: string) {
  const context = captureOpenClawStateWorkerContext({ path: pathname });
  const owner = ownerFor(context.admission.identity);
  const observation = { revoked: false, indeterminate: false };
  const observations = owner.observations.get(sessionId) ?? new Set<typeof observation>();
  observations.add(observation);
  owner.observations.set(sessionId, observations);
  let released = false;
  const changedMessage =
    sessionId === undefined
      ? "Worker placement inventory changed"
      : `Session ${sessionId} placement authority changed`;
  const assertUsable = () => {
    context.admission.assertCurrent();
    if (
      released ||
      observation.indeterminate ||
      !owner.active ||
      owners.get(owner.identity.key) !== owner
    ) {
      throw new Error(changedMessage);
    }
  };
  const authority = {
    assertCurrent(this: void) {
      assertUsable();
      if (observation.revoked || hasPendingPublication(owner, sessionId)) {
        throw new Error(changedMessage);
      }
    },
    release(this: void) {
      released = true;
      observations.delete(observation);
      if (observations.size === 0 && owner.observations.get(sessionId) === observations) {
        owner.observations.delete(sessionId);
      }
      if (sessionId !== undefined) {
        prunePublication(owner, sessionId);
      }
    },
  };
  return { authority, observation, owner, assertUsable };
}

/** Omit the session to observe the inventory, including placements created after an empty read. */
export function observePlacementAuthority(pathname: string, sessionId?: string) {
  return capturePlacementObservation(pathname, sessionId).authority;
}

/** Refresh only unconsumed reads; retained observations and uncertain writes stay fenced. */
export async function preparePlacementAuthorityRead<T>(
  pathname: string,
  sessionId: string,
  read: () => Promise<T>,
) {
  const { authority, observation, owner, assertUsable } = capturePlacementObservation(
    pathname,
    sessionId,
  );
  const signal = getAsyncWorkSignal();
  const assertReading = () => {
    signal?.throwIfAborted();
    assertUsable();
  };
  try {
    for (;;) {
      assertReading();
      while (hasPendingPublication(owner, sessionId)) {
        const settled = createDeferredCore();
        const unsubscribe = registerListener(owner.settlementListeners, settled.resolve);
        try {
          await racePromiseWithAbortSignal(settled.promise, signal);
        } finally {
          unsubscribe();
        }
        assertReading();
      }
      observation.revoked = false;
      const value = await read();
      assertReading();
      if (!observation.revoked && !hasPendingPublication(owner, sessionId)) {
        return { value, ...authority };
      }
    }
  } catch (error) {
    authority.release();
    throw error;
  }
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
        notifySettlement(owner);
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
  workspaceResult?: WorkspaceResultPostimage,
): { commit: () => void; rollback: () => void; invalidate: () => void } {
  return stageWorkerChange(identity, {
    kind: "claim",
    sessionId: facts.sessionId,
    facts: freezeJsonSnapshot(facts),
    workspaceResult: captureWorkspaceResultPostimage(facts.sessionId, workspaceResult),
  });
}

function captureWorkspaceResultPostimage(
  sessionId: string,
  facts?: WorkspaceResultPostimage,
): WorkspaceResultPostimage | undefined {
  if (
    facts &&
    (facts.placement.sessionId !== sessionId ||
      (facts.pendingResult && facts.pendingResult.sessionId !== sessionId))
  ) {
    throw new Error("Workspace result publication has a different session owner");
  }
  return freezeJsonSnapshot(facts);
}

/** Pending-result changes invalidate read observations without revoking turn authority. */
export function stagePlacementWorkspaceResultWorkerPublication(
  identity: DatabasePathIdentity,
  sessionId: string,
  facts?: WorkspaceResultPostimage,
) {
  return stageWorkerChange(identity, {
    kind: "workspace-result",
    sessionId,
    facts: captureWorkspaceResultPostimage(sessionId, facts),
  });
}

export function stagePlacementWorkspaceJournalWorkerPublication(
  identity: DatabasePathIdentity,
  sessionId: string,
) {
  return stageWorkerChange(identity, { kind: "journal", sessionId });
}

/** Current result custody is published by its writer; discovery snapshots grant no authority. */
export function readPlacementWorkspaceResultAuthority(
  identity: DatabasePathIdentity,
  claim: WorkerSessionTurnClaim,
): WorkspaceResultFacts | undefined {
  const owner = owners.get(identity.key);
  const facts = owner?.workspaceResults.get(claim.sessionId);
  if (
    !owner?.active ||
    !facts ||
    [...owner.pending].some(
      (change) => change.kind !== "tools" && change.sessionId === claim.sessionId,
    ) ||
    !matchesWorkspaceResultClaim(facts.placement, facts.pendingResult, claim)
  ) {
    return undefined;
  }
  return facts;
}

/** Bind the worker read to the original store before yielding and reject obsolete snapshots. */
export async function preparePlacementWorkspaceResultAuthority(
  pathname: string,
  requestedClaim: WorkerSessionTurnClaim,
  read: (sessionIds: readonly string[]) => Promise<{
    placements: ReadonlyMap<string, WorkerSessionPlacementRecord>;
    pendingResults: ReadonlyMap<string, WorkerWorkspacePendingResult>;
  }>,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext({ path: pathname });
  const identity = context.admission.identity;
  const owner = ownerFor(identity);
  const claim = structuredClone(requestedClaim);
  claim.sessionId = required(claim.sessionId, "session id");
  const publicationSequence = owner.published.get(claim.sessionId) ?? 0;
  const observation = observePlacementAuthority(pathname, claim.sessionId);
  try {
    const projection = await read([claim.sessionId]);
    context.admission.assertCurrent();
    if (
      (owner.published.get(claim.sessionId) ?? 0) > publicationSequence &&
      readPlacementWorkspaceResultAuthority(identity, claim)
    ) {
      return;
    }
    observation.assertCurrent();
    const placement = projection.placements.get(claim.sessionId);
    const pendingResult = projection.pendingResults.get(claim.sessionId);
    if (
      placement &&
      pendingResult &&
      isCurrentWorkerWorkspacePendingResultOwner(placement, pendingResult)
    ) {
      owner.workspaceResults.set(claim.sessionId, freezeJsonSnapshot({ placement, pendingResult }));
    } else {
      owner.workspaceResults.delete(claim.sessionId);
    }
    if (
      !placement ||
      !pendingResult ||
      !matchesWorkspaceResultClaim(placement, pendingResult, claim)
    ) {
      throw new Error(`Session ${claim.sessionId} workspace result authority changed`);
    }
  } finally {
    observation.release();
  }
}

export function stagePlacementTurnToolWorkerPublication(
  identity: DatabasePathIdentity,
  input: { claim: WorkerSessionTurnClaim; toolNames: readonly string[] | null },
) {
  return stageWorkerChange(identity, {
    kind: "tools",
    sessionId: input.claim.sessionId,
    claimId: input.claim.claimId,
    ...(input.toolNames === null
      ? {}
      : { authority: structuredClone({ claim: input.claim, toolNames: input.toolNames }) }),
  });
}

export function publishPlacementTurnToolState(
  db: DatabaseSync,
  identity: { sessionId: string; claimId: string },
): void {
  stageChange(db, { kind: "tools", sessionId: identity.sessionId, claimId: identity.claimId });
}

export function isPlacementTurnToolAuthorized(
  identity: DatabasePathIdentity,
  claim: WorkerSessionTurnClaim,
  toolName: string,
): boolean {
  const owner = owners.get(identity.key);
  const tools = owner?.tools.get(claim.sessionId)?.authority;
  return Boolean(
    claim.owner.kind === "worker" &&
    owner?.active &&
    tools &&
    sameWorkerSessionTurnClaim(tools.claim, claim) &&
    tools.toolNames.includes(toolName) &&
    [...owner.pending].every(
      (change) =>
        allows(change, claim) &&
        (change.sessionId !== claim.sessionId ||
          change.kind !== "tools" ||
          (change.authority &&
            sameWorkerSessionTurnClaim(change.authority.claim, claim) &&
            change.authority.toolNames.includes(toolName))),
    ),
  );
}

function stageWorkerChange(identity: DatabasePathIdentity, input: ClaimChange) {
  const owner = ownerFor(identity);
  const sequence = ++owner.sequence;
  const change = { ...input, sequence };
  owner.pending.add(change);
  let settled = false;
  const settle = (apply: () => void) => {
    if (!settled) {
      settled = true;
      apply();
    }
  };
  const publish = () => {
    commitChange(owner, change, sequence);
    for (const retained of Array.from(owner.claims.get(change.sessionId) ?? [])) {
      notifyRevoked(retained);
    }
  };
  return {
    commit: () => settle(publish),
    rollback: () =>
      settle(() => {
        owner.pending.delete(change);
        notifySettlement(owner);
        prunePublication(owner, change.sessionId);
      }),
    invalidate: () =>
      settle(() => {
        change.indeterminate = true;
        // Uncertain claim/tool writes revoke that incarnation. Workspace-only writes
        // invalidate read observations while preserving the separate turn authority.
        if (change.kind === "tools") {
          change.authority = undefined;
        } else if (change.kind === "journal") {
          change.uncertain = true;
        } else if (change.kind === "claim" || change.kind === "workspace-result") {
          change.facts = undefined;
          if (change.kind === "claim") {
            change.workspaceResult = undefined;
            change.workspacePlacement = undefined;
          }
        }
        publish();
      }),
  };
}

/** Publish only an existing successful writer postimage; this performs no database read. */
export function publishPlacementTurnClaimState(
  db: DatabaseSync,
  record: WorkerSessionPlacementRecord,
): void {
  const snapshot = freezeJsonSnapshot(structuredClone(record));
  stageChange(db, {
    kind: "claim",
    sessionId: snapshot.sessionId,
    workspacePlacement: snapshot,
    facts: snapshot,
  });
}

export function publishPlacementTurnClaimCleared(db: DatabaseSync, sessionId: string): void {
  stageChange(db, { kind: "claim", sessionId });
}

export function publishPlacementWorkspaceResultState(db: DatabaseSync, sessionId: string): void {
  stageChange(db, { kind: "workspace-result", sessionId });
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
        return registerListener(retained.listeners, listener);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
