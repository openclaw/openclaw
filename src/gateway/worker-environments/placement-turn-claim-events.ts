import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerTurnAdmissionParams,
  WorkerTurnAdmissionResult,
} from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { WORKER_TURN_ADMISSION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import type {
  AdmittedRunOperatorAuthority,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { captureRequesterOrigin, type RequesterOrigin } from "../../agents/requester-origin.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureAgentRunDelegatedSourceAssertion,
  claimAgentRunApprovalAuthority,
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../../process/gateway-work-admission.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { extractAssistantTranscriptSourceText } from "../../shared/chat-message-content.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { notifyListeners } from "../../shared/listeners.js";
import type { WorkerConnectionIdentity, WorkerInferenceExecutor } from "./connection-identity.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";
import type { WorkerExecApprovalOwner } from "./worker-exec-approval-contract.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import type { WorkerReplyMediaPreparer } from "./worker-reply-media.types.js";
import type { WorkerTurnPromptCacheContext } from "./worker-turn-prompt.types.js";

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
  /** Authenticated requester facts remain on the host and confer no worker authority. */
  requesterOrigin?: RequesterOrigin;
  /** Original presence reader, retained on the Gateway without a worker-writable claim. */
  assertPresenceSourceCurrent?: () => void;
  receiptAuthority: () => void;
  sessionKey: string;
  sessionTarget: Readonly<
    BoundAgentRunSessionTarget & ReturnType<typeof captureSessionTranscriptTargetBinding>
  >;
  turnClaim: WorkerSessionTurnClaim;
}>;

export type WorkerTurnTranscriptSource = Pick<
  WorkerTurnExecutionIdentity,
  "sessionTarget" | "receiptAuthority"
>;

export type WorkerTurnExecutionIdentityCapability = WorkerTurnTranscriptSource &
  Readonly<{
    assertPresenceSourceCurrent?: () => void;
    run<T>(callback: (identity: WorkerTurnExecutionIdentity) => Promise<T> | T): Promise<T>;
  }>;

type WorkerTurnFinishingOutcome = { error?: string; replayInvalid?: true };

type BoundWorkerTurnOwner = {
  capability: WorkerTurnExecutionIdentityCapability;
  claimKey: string;
  runtime: {
    assertActive: () => void;
    toolSurface?: WorkerGatewayToolRuntime;
    inference?: WorkerInferenceExecutor;
    admitTurn?: WorkerTurnAdmission;
    execApproval?: WorkerExecApprovalOwner;
    inputApproved?: boolean;
    prepareReplyMedia?: WorkerReplyMediaPreparer;
    githubGrant?: WorkerGitHubBindingGrant;
    delegatedAuthority: AgentRunDelegatedAuthority;
    approvalLifetime: AbortController;
    finishing?: {
      credentialHash: string;
      seq: number;
      outcome: WorkerTurnFinishingOutcome;
      isAckCurrent?: () => boolean;
    };
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    promptCacheContext?: WorkerTurnPromptCacheContext;
    scope?: GatewayRootWorkAdmissionContinuationScope;
    claimAuthority: PlacementTurnClaimAuthority;
    stopWatchingAuthority?: () => void;
  };
};

type WorkerTurnAdmission = (
  request: WorkerTurnAdmissionParams,
  assertCurrent: () => void,
  recordApproval: () => void,
) => Promise<WorkerTurnAdmissionResult>;

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
  assertPresenceSourceCurrent?: () => void,
  promptCacheContext?: WorkerTurnPromptCacheContext,
  requesterOrigin?: RequesterOrigin,
): Promise<
  Readonly<{
    capability: WorkerTurnExecutionIdentityCapability;
    takeFinishingOutcome: (credentialHash: string) => WorkerTurnFinishingOutcome | undefined;
  }>
> {
  let claim = structuredClone(requestedClaim);
  const preparedRequesterOrigin = requesterOrigin
    ? captureRequesterOrigin({ requesterOrigin })
    : undefined;
  const sessionTarget = Object.freeze(captureSessionTranscriptTargetBinding(requestedSource));
  const preparedPromptCacheContext = promptCacheContext
    ? Object.freeze({ ...promptCacheContext })
    : undefined;
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
  const refuseOwner: () => never = () => {
    throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
  };
  const delegatedSource = captureAgentRunDelegatedSourceAssertion(delegatedAuthority, refuseOwner);
  if (!delegatedSource) {
    approvalLifetime.abort();
    authority.release();
    scope?.release();
    refuseOwner();
  }
  const assertOwnerCurrent = () => {
    if (
      owners.get(claim.sessionId) !== owner ||
      workerTurnOwners.get(path) !== owners ||
      !authority.isCurrent()
    ) {
      refuseOwner();
    }
    delegatedSource.assertBinding();
  };
  const assertActive = composeSessionSourceAssertion(
    [delegatedSource.assertCurrent, assertRunActive, operatorAuthority?.assertCurrent],
    (assertSources) => {
      assertSources();
      assertOwnerCurrent();
    },
  );
  const identity = Object.freeze({
    agentId: sessionTarget.agentId,
    delegatedAuthority,
    ...(token ? { executionIdentityToken: token } : {}),
    operationalRunInstance,
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(preparedRequesterOrigin ? { requesterOrigin: preparedRequesterOrigin } : {}),
    ...(assertPresenceSourceCurrent ? { assertPresenceSourceCurrent } : {}),
    receiptAuthority: assertActive,
    sessionKey: sessionTarget.sessionKey,
    sessionTarget,
    turnClaim: claim,
  });
  const capability = Object.freeze({
    sessionTarget,
    receiptAuthority: assertActive,
    ...(assertPresenceSourceCurrent ? { assertPresenceSourceCurrent } : {}),
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
    claimKey: currentClaimKey,
    runtime: {
      assertActive,
      delegatedAuthority,
      approvalLifetime,
      prepareAssistantTranscriptMessage,
      promptCacheContext: preparedPromptCacheContext,
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
    validateAgentRunDelegatedAuthority(delegatedAuthority, bound.runtime.delegatedAuthority) &&
    isBoundCurrent();
}

function resolveBoundWorkerTurnRuntime(
  identity: Pick<
    WorkerConnectionIdentity,
    "turnClaim" | "sessionId" | "runId" | "environmentId" | "ownerEpoch"
  >,
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
  return owner?.runtime.claimAuthority.isCurrent() ? owner.runtime : undefined;
}

function resolveWorkerTurnRuntime(identity: Parameters<typeof resolveBoundWorkerTurnRuntime>[0]) {
  const runtime = resolveBoundWorkerTurnRuntime(identity);
  return runtime && validateAgentRunDelegatedAuthority(runtime.delegatedAuthority)
    ? runtime
    : undefined;
}

/** Cache identity follows the Gateway's admitted transcript, never worker-supplied history. */
export function readWorkerTurnPromptCacheContext(
  identity: WorkerConnectionIdentity,
): WorkerTurnPromptCacheContext | undefined {
  return resolveWorkerTurnRuntime(identity)?.promptCacheContext;
}

export function bindWorkerTurnCapabilities(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
  capabilities: {
    toolSurface: WorkerGatewayToolRuntime;
    prepareReplyMedia?: WorkerReplyMediaPreparer;
    inference?: WorkerInferenceExecutor;
    admitTurn?: WorkerTurnAdmission;
    execApproval?: WorkerExecApprovalOwner;
  },
): () => void {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const owner = path ? workerTurnOwners.get(path)?.get(claim.sessionId) : undefined;
  if (
    !owner ||
    owner.claimKey !== claimKey(claim) ||
    !owner.runtime.claimAuthority.isCurrent() ||
    !validateAgentRunDelegatedAuthority(owner.runtime.delegatedAuthority)
  ) {
    throw new Error("Worker turn has no admitted tool surface owner");
  }
  owner.runtime.toolSurface?.abort();
  Object.assign(owner.runtime, capabilities);
  owner.runtime.inputApproved = false;
  // Finalization retains this claim's decision after execution authority closes.
  return () => {
    if (capabilities.admitTurn) {
      assertWorkerTurnInputApproval(owner.runtime);
    }
  };
}

export function captureWorkerReplyMedia(identity: WorkerConnectionIdentity) {
  return resolveWorkerTurnRuntime(identity)?.prepareReplyMedia;
}

export function getWorkerTurnToolSurface(identity: Parameters<typeof resolveWorkerTurnRuntime>[0]) {
  return resolveWorkerTurnRuntime(identity)?.toolSurface;
}

export function getWorkerTurnExecApproval(identity: WorkerConnectionIdentity) {
  return resolveWorkerTurnRuntime(identity)?.execApproval;
}

/** The exact admitted turn retains the grant; reconnects cannot elect another issuer. */
export function bindWorkerTurnGitHubGrant(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
  grant: WorkerGitHubBindingGrant,
): void {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const owner = path ? workerTurnOwners.get(path)?.get(claim.sessionId) : undefined;
  if (
    !owner ||
    owner.claimKey !== claimKey(claim) ||
    !owner.runtime.claimAuthority.isCurrent() ||
    !validateAgentRunDelegatedAuthority(owner.runtime.delegatedAuthority) ||
    owner.runtime.githubGrant
  ) {
    throw new Error("Worker GitHub grant lost its admitted turn owner");
  }
  owner.runtime.githubGrant = grant;
}

export function getWorkerTurnGitHubGrant(identity: WorkerConnectionIdentity) {
  return resolveWorkerTurnRuntime(identity)?.githubGrant;
}

/** Publication consumes both the retained grant and its current turn/profile authority. */
export function assertWorkerTurnGitHubGrantCurrent(
  identity: WorkerConnectionIdentity,
  expected: WorkerGitHubBindingGrant | undefined,
): void {
  if (getWorkerTurnGitHubGrant(identity) !== expected) {
    throw new Error("Worker GitHub grant owner changed");
  }
  expected?.assertCurrent?.();
}

export function getWorkerTurnInference(identity: WorkerConnectionIdentity) {
  return resolveWorkerTurnRuntime(identity)?.inference;
}

function assertWorkerTurnInputApproval(runtime: BoundWorkerTurnOwner["runtime"] | undefined): void {
  if (!runtime?.inputApproved) {
    throw new Error("Worker turn input admission is required before persistence or inference");
  }
}

export function assertWorkerTurnInputAdmitted(identity: WorkerConnectionIdentity): void {
  const runtime = resolveWorkerTurnRuntime(identity);
  if (
    runtime?.admitTurn ||
    identity.protocolFeatures.includes(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE)
  ) {
    assertWorkerTurnInputApproval(runtime);
    runtime?.assertActive();
  }
}

/** Cancellation closes execution, but the exact claim retains its prior input decision. */
export function assertWorkerTurnLiveEventInputAdmitted(identity: WorkerConnectionIdentity): void {
  const runtime = resolveBoundWorkerTurnRuntime(identity);
  if (
    runtime?.admitTurn ||
    identity.protocolFeatures.includes(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE)
  ) {
    assertWorkerTurnInputApproval(runtime);
  }
}

export async function admitWorkerTurnInput(
  identity: WorkerConnectionIdentity,
  request: WorkerTurnAdmissionParams,
  validate: () => boolean,
) {
  const runtime = resolveWorkerTurnRuntime(identity);
  if (!runtime?.admitTurn || !validate()) {
    return { ok: false as const, closeReason: "placement-mismatch" as const };
  }
  const assertCurrent = () => {
    if (!validate()) {
      throw new Error("Worker turn admission authority changed");
    }
    runtime.assertActive();
  };
  assertCurrent();
  const result = await runtime.admitTurn(request, assertCurrent, () => {
    assertCurrent();
    // Approval belongs to this claim's callback and its captured Gateway input.
    runtime.inputApproved = true;
  });
  assertCurrent();
  return { ok: true as const, result };
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
  void owner.runtime.githubGrant?.revoke();
  owner.runtime.toolSurface?.abort();
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
  notifyListeners(workerTurnClaimClosedHandlers.get(path) ?? [], claim);
}

export function prepareWorkerTurnClaimClosed(
  path: string,
  claim: WorkerSessionTurnClaim,
): () => void {
  const captured = structuredClone(claim);
  const owner = workerTurnOwners.get(path)?.get(claim.sessionId);
  return () => closeWorkerTurnClaim(path, captured, owner);
}

export function deferWorkerTurnClaimClosed(
  db: EngineConnection,
  path: string,
  claim: WorkerSessionTurnClaim,
): void {
  if (!deferSqlitePostCommitPublication(db, prepareWorkerTurnClaimClosed(path, claim))) {
    throw new Error("Worker turn closure requires its owning transaction");
  }
}

export function deferTurnClaimRelease(db: EngineConnection, path: string, sessionId: string): void {
  if (!deferSqlitePostCommitPublication(db, () => signalTurnClaimRelease(path, sessionId))) {
    throw new Error("Worker turn release requires its owning transaction");
  }
}
