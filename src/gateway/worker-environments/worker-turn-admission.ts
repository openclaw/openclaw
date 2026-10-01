import { randomUUID } from "node:crypto";
import { createSessionPlacementSettlementClosedAbortError } from "../../agents/run-termination.js";
import type {
  SessionPlacementTurnParams,
  LocalTurnPlacementClaim,
} from "../../agents/session-placement-admission.js";
import { withSessionPlacementForcedTerminalSettlement } from "../../agents/session-placement-forced-terminal-settlement.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import type { WorkerRuntimeRefreshInFlight } from "./provider-runtime-refresh.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./workspace-conflicts.js";

type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

/** Wait without a placement claim: a claim would fail the refresh's authority check. */
export async function waitForWorkerRuntimeRefresh(params: {
  refresh: WorkerRuntimeRefreshInFlight;
  signal?: AbortSignal;
  timeoutMs: number;
  onProgress: () => void;
}): Promise<void> {
  const unsubscribe = params.refresh.onProgress(params.onProgress);
  try {
    await waitForTurnOperation({
      start: () => params.refresh.settled,
      signal: AbortSignal.any([
        getGatewayRestartDrainSignal(),
        ...(params.signal ? [params.signal] : []),
      ]),
      timeoutMs: params.timeoutMs,
    });
  } finally {
    unsubscribe();
  }
}

/** Wait for live reconciliation, or report a retained result that needs recovery. */
export async function waitForPendingWorkerResult(params: {
  placements: WorkerSessionPlacementStore;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<void> {
  // Healthy result reconciliation owns the turn until its durable claim closes; timing out would
  // surface a false resend instruction. Caller cancellation remains abortable.
  await params.placements.waitForTurnClaimRelease(
    params.sessionId,
    params.signal ? { signal: params.signal } : {},
  );
  // Restart clears local claims without discarding durable results. A claimless result cannot
  // make progress through this wait; keep its fence and let recovery retain control of the files.
  if (
    !params.placements.get(params.sessionId)?.turnClaim &&
    params.placements
      .listPendingWorkspaceResults(params.sessionId)
      .some((pending) => pending.sessionId === params.sessionId)
  ) {
    throw new Error(
      "Workspace recovery is still pending after its turn ended. " +
        "Wait for workspace recovery to finish before retrying; if it remains blocked, inspect the cloud worker recovery error.",
    );
  }
}
/** Join live setup without admitting work against a stale session or destination. */
export async function waitForInitialWorkerPlacement(params: {
  placements: WorkerSessionPlacementStore;
  placement: WorkerSessionPlacementRecord;
  turn: SessionPlacementTurnParams;
  wait: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerSessionPlacementRecord>;
  assertRunCurrent?: () => void;
}): Promise<{ placement: ActiveWorkerPlacement; assertCurrent: () => void }> {
  const identity = resolvePlacementIdentity(params.turn, params.placement);
  const target = {
    ...identity,
    storePath: params.turn.sessionTarget?.storePath ?? resolveSessionStorePathForScope(identity),
  };
  const original = loadSessionEntryReadOnly(target);
  const assertSessionCurrent = () => {
    params.turn.abortSignal?.throwIfAborted();
    params.assertRunCurrent?.();
    const current = loadSessionEntryReadOnly(target);
    if (
      !original ||
      !current ||
      current.sessionId !== identity.sessionId ||
      current.archivedAt !== undefined ||
      current.lifecycleRevision !== original.lifecycleRevision ||
      current.activeWriterRunId !== original.activeWriterRunId
    ) {
      throw createAbortError("Session changed while waiting for worker setup");
    }
  };
  assertSessionCurrent();
  const completed = await params.wait(params.placement, params.turn.abortSignal);
  // Setup completion is a notification, not authority: read the durable owner again.
  assertSessionCurrent();
  const assertCurrent = () => {
    assertSessionCurrent();
    const current = params.placements.get(identity.sessionId);
    if (
      !current ||
      !matchesWorkerPlacementTarget(current, completed) ||
      current.sessionKey !== identity.sessionKey ||
      current.agentId !== identity.agentId ||
      current.executionMode !== params.placement.executionMode
    ) {
      throw createAbortError("Worker placement changed while waiting for setup");
    }
  };
  assertCurrent();
  return {
    placement: requireActivePlacement(params.placements.get(identity.sessionId)!),
    assertCurrent,
  };
}

export function latestDurableWorkspaceConflict(
  entries: ReturnType<SessionManager["getBranch"]>,
): WorkerWorkspaceResultConflict | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== "custom_message") {
      continue;
    }
    if (entry.customType === WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE) {
      return undefined;
    }
    if (entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
      continue;
    }
    const details = entry.details as
      | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
      | null
      | undefined;
    if (
      !Array.isArray(details?.paths) ||
      details.paths.length === 0 ||
      !details.paths.every(
        (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
      ) ||
      typeof details.stagedResultRef !== "string" ||
      (details.totalCount !== undefined &&
        (!Number.isSafeInteger(details.totalCount) ||
          (details.totalCount as number) < details.paths.length)) ||
      !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef)
    ) {
      return undefined;
    }
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  }
  return undefined;
}

export async function waitForTurnOperation<T>(params: {
  start: () => Promise<T>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<T> {
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const abortError = () =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error("Cloud worker operation aborted", { cause: signal.reason });
  if (signal.aborted) {
    throw abortError();
  }
  // Never start for a cancelled caller; always observe a started operation.
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    params
      .start()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function resolvePlacementIdentityField(
  supplied: string | undefined,
  persisted: string | undefined,
  field: string,
): string {
  const resolved = supplied === undefined && persisted ? persisted : supplied?.trim();
  if (!resolved) {
    throw new Error(`Worker turn ${field} is required`);
  }
  if (persisted && resolved !== persisted) {
    throw new Error(`Worker turn ${field} does not match its placement`);
  }
  return resolved;
}

export function resolvePlacementIdentity(
  claim: LocalTurnPlacementClaim,
  placement: WorkerSessionPlacementRecord | undefined,
) {
  const sessionKey = claim.sessionKey?.trim();
  // A detached cron root addresses its recorded exact run, but row checks must
  // retain the caller's key. Remote placement identities stay exact.
  const localCronAlias =
    placement?.state === "local" &&
    sessionKey &&
    parseCronRunScopeSuffix(placement.sessionKey).baseSessionKey === sessionKey;
  return {
    sessionId: claim.sessionId,
    agentId: resolvePlacementIdentityField(claim.agentId, placement?.agentId, "agent id"),
    sessionKey: localCronAlias
      ? sessionKey
      : resolvePlacementIdentityField(claim.sessionKey, placement?.sessionKey, "session key"),
  };
}

export function requireActivePlacement(
  placement: WorkerSessionPlacementRecord,
): ActiveWorkerPlacement {
  const failureDetail = placement.state === "failed" ? `: ${placement.recoveryError}` : "";
  if (
    placement.state !== "active" ||
    !placement.remoteWorkspaceDir ||
    !placement.workerBundleHash
  ) {
    throw new Error(`Worker turn rejected in placement ${placement.state}${failureDetail}`);
  }
  return placement;
}

export async function releaseClaimIfOwned(
  placements: WorkerSessionPlacementStore,
  turnClaim: WorkerSessionTurnClaim,
): Promise<void> {
  if (turnClaim.owner.kind === "worker" && placements.validateTurnClaim(turnClaim)) {
    await placements.closeWorkerTurnToolState(turnClaim);
  }
  await placements.releaseTurnIfOwned(turnClaim);
}

export async function executeLocalTurn<T>(params: {
  claim: LocalTurnPlacementClaim;
  placements: WorkerSessionPlacementStore;
  runLocal: () => Promise<T>;
  assertCurrent?: () => void;
}): Promise<T> {
  const current = (await params.placements.readProjection([params.claim.sessionId])).placements.get(
    params.claim.sessionId,
  );
  params.assertCurrent?.();
  const identity = resolvePlacementIdentity(params.claim, current);
  const sessionEntry = loadSessionEntryReadOnly({
    ...identity,
    storePath: resolveSessionStorePathForScope(identity),
  });
  if (sessionEntry?.repositoryWorkspaceId) {
    throw new Error(
      "This repository session needs a cloud worker. Choose a cloud environment and retry.",
    );
  }
  const turnClaim = await params.placements.claimTurn(
    {
      ...identity,
      sessionKey: current?.sessionKey ?? identity.sessionKey,
      claimId: randomUUID(),
      runId: params.claim.runId,
      owner: { kind: "local" },
    },
    params.assertCurrent,
  );
  // Forced terminalization and ordinary completion share this exact-claim closure.
  // Replacement fencing makes a late finally harmless after recovery settles it.
  let closed = false;
  let settlement: Promise<void> | undefined;
  const settle = () => {
    closed = true;
    // Both completion paths own the same outcome, including terminal refusal.
    // Conditional release itself retains retryable precommit contention.
    return (settlement ??= releaseClaimIfOwned(params.placements, turnClaim));
  };
  let authority:
    | Awaited<ReturnType<WorkerSessionPlacementStore["prepareTurnClaimAuthority"]>>
    | undefined;
  try {
    authority = await params.placements.prepareTurnClaimAuthority(turnClaim);
    params.assertCurrent?.();
    return await withSessionPlacementForcedTerminalSettlement(
      settle,
      () => {
        if (closed || !authority?.isCurrent()) {
          throw createSessionPlacementSettlementClosedAbortError();
        }
      },
      params.runLocal,
    );
  } finally {
    try {
      await settle();
    } finally {
      authority?.release();
    }
  }
}

export async function claimWorkerTurn(params: {
  placements: WorkerSessionPlacementStore;
  identity: ReturnType<typeof resolvePlacementIdentity>;
  placement: ActiveWorkerPlacement;
  runId: string;
  isCancellationRequested: (claim: WorkerSessionTurnClaim) => boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<{ placement: ActiveWorkerPlacement; turnClaim: WorkerSessionTurnClaim } | null> {
  const claim = () =>
    params.placements.claimTurn(
      {
        ...params.identity,
        claimId: randomUUID(),
        runId: params.runId,
        owner: {
          kind: "worker",
          environmentId: params.placement.environmentId,
          ownerEpoch: params.placement.activeOwnerEpoch,
        },
      },
      () => {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
      },
    );
  try {
    return { placement: params.placement, turnClaim: await claim() };
  } catch (error) {
    if (!(error instanceof ActiveTurnClaimError)) {
      throw error;
    }
    const activePlacement = params.placements.get(params.identity.sessionId);
    const activeClaim = activePlacement?.turnClaim;
    if (activeClaim?.runId === params.runId) {
      throw error;
    }
    const resultIsReconciling = params.placements
      .listPendingWorkspaceResults(params.identity.sessionId)
      .some(
        (pending) =>
          activeClaim?.owner === "worker" &&
          pending.sessionId === params.identity.sessionId &&
          pending.claimId === activeClaim.claimId &&
          pending.runId === activeClaim.runId,
      );
    const cancelledClaim = activePlacement && projectWorkerSessionTurnClaim(activePlacement);
    if (resultIsReconciling) {
      await waitForPendingWorkerResult({
        placements: params.placements,
        sessionId: params.identity.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return null;
    }
    if (!(cancelledClaim && params.isCancellationRequested(cancelledClaim))) {
      const refreshed = params.placements.get(params.identity.sessionId);
      if (
        refreshed?.state !== "active" ||
        !matchesWorkerPlacementTarget(refreshed, params.placement) ||
        refreshed.turnClaim
      ) {
        throw error;
      }
      return { placement: refreshed, turnClaim: await claim() };
    }
  }
  await params.placements.waitForTurnClaimRelease(params.identity.sessionId, {
    timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const refreshed = params.placements.get(params.identity.sessionId);
  if (refreshed?.state !== "active" || !matchesWorkerPlacementTarget(refreshed, params.placement)) {
    throw new Error("Cloud worker placement changed while waiting for the previous turn");
  }
  return { placement: refreshed, turnClaim: await claim() };
}
