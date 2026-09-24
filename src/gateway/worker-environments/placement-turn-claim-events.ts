import type { DatabaseSync } from "node:sqlite";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  claimAgentRunApprovalAuthority,
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../../process/gateway-work-admission.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { extractAssistantTranscriptSourceText } from "../../shared/chat-message-content.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";

type TurnClaimReleaseWaiter = (error?: Error) => void;

const turnClaimReleaseWaiters = resolveGlobalMap<string, Map<string, Set<TurnClaimReleaseWaiter>>>(
  Symbol.for("openclaw.turnClaimReleaseWaiters"),
  (waitersByPath) => {
    const error = new Error("Gateway lifecycle ended while waiting for turn claim release");
    for (const bySession of waitersByPath.values()) {
      for (const waiters of bySession.values()) {
        for (const reject of waiters) {
          reject(error);
        }
      }
    }
    waitersByPath.clear();
  },
);

const workerTurnClaimClosedHandlers = resolveGlobalMap<
  string,
  Set<(claim: WorkerSessionTurnClaim) => void>
>(Symbol.for("openclaw.workerTurnClaimClosedHandlers"), (handlersByPath) => {
  handlersByPath.clear();
});

export type WorkerTurnExecutionIdentity = Readonly<{
  agentId: string;
  delegatedAuthority: AgentRunDelegatedAuthority;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  operationalRunInstance: OperationalRunInstanceRef;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  directHumanRequesterProfileId?: string;
  receiptAuthority: () => void;
  sessionKey: string;
  sessionTarget: Readonly<BoundAgentRunSessionTarget>;
  turnClaim: WorkerSessionTurnClaim;
}>;

export type WorkerTurnTranscriptSource = Pick<
  WorkerTurnExecutionIdentity,
  "sessionTarget" | "receiptAuthority"
>;

export type WorkerTurnExecutionIdentityCapability = WorkerTurnTranscriptSource &
  Readonly<{
    run<T>(callback: (identity: WorkerTurnExecutionIdentity) => Promise<T> | T): Promise<T>;
  }>;

type WorkerTurnFinishingOutcome = { error?: string; replayInvalid?: true };

type BoundWorkerTurnOwner = {
  capability: WorkerTurnExecutionIdentityCapability;
  claim: WorkerSessionTurnClaim;
  claimKey: string;
  runtime: {
    assertActive: () => void;
    delegatedAuthority: AgentRunDelegatedAuthority;
    approvalLifetime: AbortController;
    finishing?: {
      credentialHash: string;
      seq: number;
      outcome: WorkerTurnFinishingOutcome;
      isAckCurrent?: () => boolean;
    };
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    scope?: GatewayRootWorkAdmissionContinuationScope;
    claimAuthority: PlacementTurnClaimAuthority;
    stopWatchingAuthority?: () => void;
  };
};

const workerTurnOwners = resolveGlobalMap<string, Map<string, BoundWorkerTurnOwner>>(
  Symbol.for("openclaw.workerTurnExecutionIdentities"),
  (ownersByPath) => {
    for (const owners of ownersByPath.values()) {
      for (const owner of owners.values()) {
        closeBoundOwner(owner);
      }
    }
    ownersByPath.clear();
  },
);

const WORKER_TURN_EXECUTION_IDENTITY_PATH = Symbol("workerTurnExecutionIdentityPath");
export type WorkerTurnExecutionIdentityStore = {
  prepareTurnClaimAuthority(claim: WorkerSessionTurnClaim): Promise<PlacementTurnClaimAuthority>;
  [WORKER_TURN_EXECUTION_IDENTITY_PATH]?: string;
};

function claimKey(claim: WorkerSessionTurnClaim): string {
  return JSON.stringify([
    claim.sessionId,
    claim.claimId,
    claim.runId,
    claim.placementGeneration,
    claim.owner.kind,
    claim.owner.environmentId ?? null,
    claim.owner.ownerEpoch ?? null,
  ]);
}

/** Bind every worker to its live run and original operator source when one exists. */
export async function bindWorkerTurnOwner(
  store: WorkerTurnExecutionIdentityStore,
  requestedClaim: WorkerSessionTurnClaim,
  token: ExecutionIdentityAdmissionToken | undefined,
  operationalRunInstance: OperationalRunInstanceRef,
  requestedSource: BoundAgentRunSessionTarget,
  assertRunActive: () => void,
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  directHumanRequesterProfileId?: string,
): Promise<
  Readonly<{
    capability: WorkerTurnExecutionIdentityCapability;
    takeFinishingOutcome: (credentialHash: string) => WorkerTurnFinishingOutcome | undefined;
  }>
> {
  let claim = structuredClone(requestedClaim);
  const sessionTarget = Object.freeze({ ...requestedSource });
  const scope = captureGatewayRootWorkAdmissionContinuationScope();
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const runAuthority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
  if (!path || !runAuthority) {
    scope?.release();
    throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
  }
  let claimAuthority: PlacementTurnClaimAuthority | undefined;
  const approvalLifetime = new AbortController();
  let delegatedAuthority: AgentRunDelegatedAuthority;
  try {
    const prepared = await store.prepareTurnClaimAuthority(claim);
    claimAuthority = prepared;
    const assertPreparedCurrent = () => {
      if (
        !prepared.isCurrent() ||
        !validateAgentRunDelegatedAuthority(runAuthority) ||
        sessionTarget.sessionId !== claim.sessionId ||
        prepared.identity.agentId !== sessionTarget.agentId ||
        prepared.identity.sessionKey !== sessionTarget.sessionKey
      ) {
        throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
      }
    };
    assertPreparedCurrent();
    assertRunActive();
    operatorAuthority?.assertCurrent();
    assertPreparedCurrent();
    delegatedAuthority = claimAgentRunApprovalAuthority(runAuthority, [approvalLifetime.signal]);
  } catch (error) {
    approvalLifetime.abort();
    claimAuthority?.release();
    scope?.release();
    throw error;
  }
  const authority = claimAuthority;
  claim = authority.claim;
  const owners = workerTurnOwners.get(path) ?? new Map();
  const assertOwnerCurrent = () => {
    if (
      owners.get(claim.sessionId) !== owner ||
      workerTurnOwners.get(path) !== owners ||
      !authority.isCurrent() ||
      !validateAgentRunDelegatedAuthority(delegatedAuthority)
    ) {
      throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
    }
  };
  const assertActive = () => {
    // A closed claim must not consult its retired source. Callbacks can also revoke it.
    assertOwnerCurrent();
    assertRunActive();
    operatorAuthority?.assertCurrent();
    assertOwnerCurrent();
  };
  const identity = Object.freeze({
    agentId: sessionTarget.agentId,
    delegatedAuthority,
    ...(token ? { executionIdentityToken: token } : {}),
    operationalRunInstance,
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(directHumanRequesterProfileId ? { directHumanRequesterProfileId } : {}),
    receiptAuthority: assertActive,
    sessionKey: sessionTarget.sessionKey,
    sessionTarget,
    turnClaim: claim,
  });
  const capability = Object.freeze({
    sessionTarget,
    receiptAuthority: assertActive,
    async run<T>(callback: (current: WorkerTurnExecutionIdentity) => Promise<T> | T): Promise<T> {
      assertActive();
      const result = await callback(identity);
      // Awaited policy, RPC, approval, and recovery work may close either owner.
      assertActive();
      return result;
    },
  });
  const existing = owners.get(claim.sessionId);
  const currentClaimKey = claimKey(claim);
  const owner: BoundWorkerTurnOwner = {
    capability,
    claim,
    claimKey: currentClaimKey,
    runtime: {
      assertActive,
      delegatedAuthority,
      approvalLifetime,
      prepareAssistantTranscriptMessage,
      scope: scope ?? undefined,
      claimAuthority: authority,
    },
  };
  const closeOwner = () => {
    if (owners.get(claim.sessionId) === owner) {
      owners.delete(claim.sessionId);
      if (owners.size === 0 && workerTurnOwners.get(path) === owners) {
        workerTurnOwners.delete(path);
      }
    }
    closeBoundOwner(owner);
  };
  try {
    if (existing) {
      closeBoundOwner(existing);
    }
    owners.set(claim.sessionId, owner);
    workerTurnOwners.set(path, owners);
    owner.runtime.stopWatchingAuthority = authority.onRevoked(closeOwner);
    assertActive();
  } catch (error) {
    closeOwner();
    throw error;
  }
  const takeFinishingOutcome = (credentialHash: string) => {
    assertActive();
    const finishing = owner.runtime.finishing;
    if (
      !finishing ||
      !safeEqualSecret(finishing.credentialHash, credentialHash) ||
      !finishing.isAckCurrent?.()
    ) {
      return undefined;
    }
    owner.runtime.finishing = undefined;
    return finishing.outcome;
  };
  return Object.freeze({ capability, takeFinishingOutcome });
}

export function getWorkerTurnExecutionIdentityCapability(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
): WorkerTurnExecutionIdentityCapability | undefined {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const bound = path ? workerTurnOwners.get(path)?.get(claim.sessionId) : undefined;
  return bound && bound.claimKey === claimKey(claim) && bound.runtime.claimAuthority.isCurrent()
    ? bound.capability
    : undefined;
}

/** Retain this operational owner's claim incarnation across an approval's awaited work. */
export function captureWorkerTurnClaimCurrentness(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
  delegatedAuthority: AgentRunDelegatedAuthority,
): (() => boolean) | undefined {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const owners = path ? workerTurnOwners.get(path) : undefined;
  const bound = owners?.get(claim.sessionId);
  const capturedKey = claimKey(claim);
  if (
    !path ||
    !bound ||
    bound.claimKey !== capturedKey ||
    !bound.runtime.claimAuthority.isCurrent()
  ) {
    return undefined;
  }
  const isBoundCurrent = () =>
    claimKey(claim) === capturedKey &&
    workerTurnOwners.get(path) === owners &&
    owners?.get(claim.sessionId) === bound &&
    bound.runtime.claimAuthority.isCurrent();
  return () =>
    isBoundCurrent() &&
    validateAgentRunDelegatedAuthority(delegatedAuthority, bound.runtime.delegatedAuthority) &&
    isBoundCurrent();
}

function resolveWorkerTurnRuntime(
  identity: WorkerConnectionIdentity,
): BoundWorkerTurnOwner["runtime"] | undefined {
  const claim = identity.turnClaim;
  if (
    !claim ||
    claim.owner.kind !== "worker" ||
    identity.sessionId !== claim.sessionId ||
    identity.runId !== claim.runId ||
    identity.environmentId !== claim.owner.environmentId ||
    identity.ownerEpoch !== claim.owner.ownerEpoch
  ) {
    return undefined;
  }
  const currentClaimKey = claimKey(claim);
  let owner: BoundWorkerTurnOwner | undefined;
  for (const owners of workerTurnOwners.values()) {
    const candidate = owners.get(claim.sessionId);
    if (candidate?.claimKey !== currentClaimKey) {
      continue;
    }
    if (owner) {
      return undefined;
    }
    owner = candidate;
  }
  const runtime = owner?.runtime;
  if (
    !owner ||
    !runtime ||
    !runtime.claimAuthority.isCurrent() ||
    !validateAgentRunDelegatedAuthority(runtime.delegatedAuthority)
  ) {
    return undefined;
  }
  return runtime;
}

/** Capture before buffering; delayed events must never bind to a replacement owner. */
export function captureWorkerTurnFinishing(
  identity: WorkerConnectionIdentity,
  request: WorkerLiveEventParams,
): (() => void) | undefined {
  if (
    request.runId !== identity.runId ||
    request.runEpoch !== identity.ownerEpoch ||
    request.event.kind !== "lifecycle" ||
    request.event.payload.phase !== "finishing"
  ) {
    return undefined;
  }
  const runtime = resolveWorkerTurnRuntime(identity);
  if (!runtime) {
    return undefined;
  }
  const finishing = {
    credentialHash: identity.credentialHash,
    seq: request.seq,
    outcome: {
      error: request.event.payload.error,
      replayInvalid: request.event.payload.replayInvalid,
    },
  };
  return () => {
    if (resolveWorkerTurnRuntime(identity) !== runtime) {
      return;
    }
    try {
      runtime.assertActive();
      runtime.finishing = finishing;
    } catch {
      // Cancellation still drains its ACK, but cannot revive a closed turn's failure.
    }
  };
}

/** The durable ACK and its admission predicate belong to the same process turn. */
export function acknowledgeWorkerTurnFinishing(
  identity: WorkerConnectionIdentity,
  ackedSeq: number,
  isAckCurrent: () => boolean,
): void {
  const runtime = resolveWorkerTurnRuntime(identity);
  const finishing = runtime?.finishing;
  if (
    !runtime ||
    !finishing ||
    finishing.seq > ackedSeq ||
    !safeEqualSecret(finishing.credentialHash, identity.credentialHash)
  ) {
    return;
  }
  try {
    runtime.assertActive();
    // Recheck at consumption too: credentials may rotate before the claim is released.
    finishing.isAckCurrent = isAckCurrent;
  } catch {
    // Retaining error detail cannot change cancellation or terminal ACK semantics.
  }
}

export function runWorkerTurnAdmissionContinuation<T>(
  identity: WorkerConnectionIdentity,
  run: () => Promise<T>,
): Promise<T> | null {
  return resolveWorkerTurnRuntime(identity)?.scope?.run(run) ?? null;
}

/** Host-owned preparation runs at append time, after any awaited transcript admission. */
export function prepareWorkerTurnTranscriptMessage(
  identity: WorkerConnectionIdentity,
  message: AssistantMessage,
): AssistantMessage {
  return (
    resolveWorkerTurnRuntime(identity)?.prepareAssistantTranscriptMessage?.(
      message,
      extractAssistantTranscriptSourceText(message),
    ) ?? message
  );
}

export function attachWorkerTurnExecutionIdentityStore(store: object, path: string): void {
  Object.defineProperty(store, WORKER_TURN_EXECUTION_IDENTITY_PATH, { value: path });
}

export function waitersFor(path: string, sessionId: string): Set<TurnClaimReleaseWaiter> {
  let bySession = turnClaimReleaseWaiters.get(path);
  if (!bySession) {
    bySession = new Map();
    turnClaimReleaseWaiters.set(path, bySession);
  }
  let waiters = bySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    bySession.set(sessionId, waiters);
  }
  return waiters;
}

function signalTurnClaimRelease(path: string, sessionId: string): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  bySession.delete(sessionId);
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

export function removeTurnClaimReleaseWaiter(
  path: string,
  sessionId: string,
  waiter: TurnClaimReleaseWaiter,
): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    bySession.delete(sessionId);
  }
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
}

export function registerWorkerTurnClaimClosedHandler(
  path: string,
  handler: (claim: WorkerSessionTurnClaim) => void,
): () => void {
  const handlers = workerTurnClaimClosedHandlers.get(path) ?? new Set();
  handlers.add(handler);
  workerTurnClaimClosedHandlers.set(path, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      workerTurnClaimClosedHandlers.delete(path);
    }
  };
}

function closeBoundOwner(owner: BoundWorkerTurnOwner): void {
  owner.runtime.approvalLifetime.abort();
  owner.runtime.finishing = undefined;
  owner.runtime.stopWatchingAuthority?.();
  owner.runtime.stopWatchingAuthority = undefined;
  try {
    owner.runtime.scope?.release();
  } finally {
    owner.runtime.claimAuthority.release();
  }
}

function closeWorkerTurnClaim(
  path: string,
  claim: WorkerSessionTurnClaim,
  expectedOwner: BoundWorkerTurnOwner | undefined,
): void {
  signalTurnClaimRelease(path, claim.sessionId);
  const owners = workerTurnOwners.get(path);
  const owner = owners?.get(claim.sessionId);
  if (owner && owner === expectedOwner && owner.claimKey === claimKey(claim)) {
    closeBoundOwner(owner);
    owners?.delete(claim.sessionId);
    if (owners?.size === 0) {
      workerTurnOwners.delete(path);
    }
  }
  for (const handler of workerTurnClaimClosedHandlers.get(path) ?? []) {
    try {
      handler(claim);
    } catch {
      // Settlement observation cannot roll back the authoritative store transition.
    }
  }
}

export function deferWorkerTurnClaimClosed(
  db: DatabaseSync,
  path: string,
  claim: WorkerSessionTurnClaim,
): void {
  const captured = structuredClone(claim);
  const owner = workerTurnOwners.get(path)?.get(claim.sessionId);
  if (!deferSqlitePostCommitPublication(db, () => closeWorkerTurnClaim(path, captured, owner))) {
    throw new Error("Worker turn closure requires its owning transaction");
  }
}

export function deferTurnClaimRelease(db: DatabaseSync, path: string, sessionId: string): void {
  if (!deferSqlitePostCommitPublication(db, () => signalTurnClaimRelease(path, sessionId))) {
    throw new Error("Worker turn release requires its owning transaction");
  }
}
