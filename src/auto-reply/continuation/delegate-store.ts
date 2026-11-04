/**
 * Canonical continuation-delegate business transitions over the continuation
 * custody store (RFC docs/design/continue-work-signal-v2.md §5.4).
 */

import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readContinuationLiveWork } from "./custody/custody-projection.js";
import {
  claimContinuationSpawnAttempt,
  recordContinuationSpawnAttemptFailure,
  resolveContinuationCustodyDatabasePath,
} from "./custody/custody-store.js";
import type { ContinuationRecordPatch } from "./custody/custody-store.types.js";
import {
  countQueuedPendingDelegates,
  createDelegateRecord,
  decodeDelegateFlow,
  decodeDelegateFlowMetadata,
  decodeDelegateState,
  type DelegateCustodyRecord,
  delegateDueAt,
  type DelegateRecordWriteResult,
  type DelegateStateChanges,
  delegateStateJsonWithChanges,
  deleteDelegateRecord,
  getDelegateRecord,
  isDurablyHandedOffPostCompactionFlow,
  isPendingDelegateFlow,
  isPostCompactionDelegateFlow,
  isRecoverableContinuationDelegateFlow,
  isRecoverablePendingFlowWithinCutoffs,
  isTerminalDelegateFlow,
  listDelegateRecords,
  listLiveDelegateRecords,
  listQueuedPendingFlows,
  type PendingDelegateCutoffOptions,
  readAcceptedDelegateChildSessionKey,
  reconcileDelegateAttachmentCustody,
  rejectCorruptDelegateFlow,
  resetDelegateFlowDiagnosticsForTests,
  resolveQueuedDelegateCounts,
  updateDelegateRecord,
} from "./delegate-flow-store.js";
import type { ChainState, PendingContinuationDelegate } from "./types.js";

export { resolveQueuedDelegateCounts };

const log = createSubsystemLogger("continuation/delegate-store");

type DelegateRef = Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">;

/** Session-queue settle and payload release follow a committed CAS; see custody-store.ts. */
export async function reconcileContinuationDelegateAttachmentCustody(
  orphanedBefore: number,
): Promise<{ removed: number; failed: number }> {
  return await reconcileDelegateAttachmentCustody(orphanedBefore);
}

export type DelegateSpawnFenceController = "pending" | "post-compaction";

export type DelegateSpawnFenceResult =
  | { allowed: true }
  | { allowed: false; reason: "cancelled" | "stale"; summary: string };

function fenceSummary(reason: "cancelled" | "stale"): string {
  return reason === "cancelled"
    ? "Continuation delegate cancelled before spawn."
    : "Continuation delegate claim became stale before spawn.";
}

function isExpectedClaim(
  record: DelegateCustodyRecord,
  controller: DelegateSpawnFenceController,
  expectedRevision: number,
): boolean {
  if (record.cancelRequestedAt !== undefined) {
    return false;
  }
  if (controller === "pending") {
    return (
      isPendingDelegateFlow(record) &&
      record.status === "running" &&
      record.revision === expectedRevision
    );
  }
  // A released post-compaction delegate is owned by its queue entry; the
  // record stays handed off unless reset fenced it.
  return (
    isPostCompactionDelegateFlow(record) &&
    ((record.status === "running" && record.revision === expectedRevision) ||
      isDurablyHandedOffPostCompactionFlow(record))
  );
}

/**
 * Re-read a claimed delegate at the last boundary before spawn. A pending
 * claim that was cancelled or superseded is terminalized so recovery cannot
 * replay stale work; a handed-off post-compaction record is left to its queue.
 */
export async function revalidatePendingDelegateForSpawn(
  delegate: DelegateRef,
  controller: DelegateSpawnFenceController,
): Promise<DelegateSpawnFenceResult> {
  const { flowId, expectedRevision } = delegate;
  if ((flowId === undefined) !== (expectedRevision === undefined)) {
    return {
      allowed: false,
      reason: "stale",
      summary: "Continuation delegate source metadata is incomplete before spawn.",
    };
  }
  if (flowId === undefined || expectedRevision === undefined) {
    return { allowed: true };
  }
  let current = await getDelegateRecord(flowId);
  if (current && isExpectedClaim(current, controller, expectedRevision)) {
    return { allowed: true };
  }
  const reason =
    current?.cancelRequestedAt !== undefined || current?.status === "cancelled"
      ? "cancelled"
      : "stale";
  const summary = fenceSummary(reason);
  for (let attempt = 0; attempt < 2 && current; attempt += 1) {
    if (isTerminalDelegateFlow(current)) {
      break;
    }
    const failed = await updateDelegateRecord({
      record: current,
      patch: {
        status: "failed",
        phase:
          reason === "cancelled"
            ? "Cancelled before continuation delegate spawn"
            : "Rejected stale continuation delegate spawn claim",
        failureReason: summary,
      },
    });
    if (failed.applied || !failed.current) {
      break;
    }
    current = failed.current;
  }
  return { allowed: false, reason, summary };
}

/**
 * Synchronous claim check for spawn-admission boundaries, answered from the
 * hot-path projection (§5.4.6). A pending claim must still be the live
 * `running` record at the claimed revision. The authoritative read happened in
 * {@link revalidatePendingDelegateForSpawn} just before spawn; this notices a
 * cancel or supersede committed since. An owner the projection cannot answer
 * for is left to that read and to the dispatch claim's abort signal. A
 * released post-compaction delegate is owned by its queue entry, which reset
 * settles directly, so it has no projected claim to check.
 */
export function checkPendingDelegateClaimInProjection(
  delegate: DelegateRef,
  controller: DelegateSpawnFenceController,
  ownerSessionKey: string,
): DelegateSpawnFenceResult {
  const { flowId, expectedRevision } = delegate;
  if (controller !== "pending" || flowId === undefined || expectedRevision === undefined) {
    return { allowed: true };
  }
  const answer = readContinuationLiveWork(
    resolveContinuationCustodyDatabasePath(),
    ownerSessionKey,
    ["delegate"],
  );
  if (answer.state !== "known") {
    return { allowed: true };
  }
  const fact = answer.records.find((record) => record.recordId === flowId);
  if (fact?.status === "running" && fact.revision === expectedRevision && !fact.cancelRequested) {
    return { allowed: true };
  }
  const reason = fact?.cancelRequested ? "cancelled" : "stale";
  return { allowed: false, reason, summary: fenceSummary(reason) };
}

/** The delegate a run already elected, so a replayed terminal token does not elect twice. */
export async function findContinuationDelegateFlowByOriginRun(
  ownerSessionKey: string,
  originRunId: string,
): Promise<DelegateCustodyRecord | undefined> {
  return (await listDelegateRecords({ ownerSessionKey })).find(
    (record) => decodeDelegateState(record)?.originRunId === originRunId,
  );
}

/** Whether a failed spawn provably never reached the Gateway (RFC §5.4.4). */
export function spawnResultNeverDispatched(result: {
  failurePhase?: "initialize" | "dispatch" | "register";
  runId?: string;
}): boolean {
  return result.failurePhase !== undefined
    ? result.failurePhase === "initialize"
    : result.runId === undefined;
}

/** Enqueue a delegate from the `continue_delegate` tool or the response token. */
export async function enqueuePendingDelegate(
  sessionKey: string,
  delegate: PendingContinuationDelegate,
  options: {
    attachmentConfig?: OpenClawConfig;
    electingOperatorAuthority?: AdmittedRunOperatorAuthority;
  } = {},
): Promise<DelegateCustodyRecord> {
  const isPostCompaction = delegate.mode === "post-compaction";
  return await createDelegateRecord({
    ownerKey: sessionKey,
    controller: isPostCompaction ? "post-compaction" : "pending",
    delegate,
    phase: isPostCompaction
      ? "Staged for release after compaction"
      : "Queued for continuation dispatch",
    ...(options.attachmentConfig ? { attachmentConfig: options.attachmentConfig } : {}),
    electingOperatorAuthority: options.electingOperatorAuthority,
  });
}

async function listCutoffEligibleDelegateRecords(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning">,
): Promise<DelegateCustodyRecord[]> {
  return (await listLiveDelegateRecords({ kinds: ["delegate"] })).filter((record) =>
    isRecoverablePendingFlowWithinCutoffs(record, {
      includeRunning: true,
      queuedCreatedAtOrBefore: options.queuedCreatedAtOrBefore,
      includeRunningUpdatedAtOrBefore: options.includeRunningUpdatedAtOrBefore,
    }),
  );
}

export async function listPendingDelegateSessionKeysForRecovery(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): Promise<string[]> {
  const sessionKeys: string[] = [];
  for (const record of await listCutoffEligibleDelegateRecords(options)) {
    // Validate before the recovery dispatcher loads the owning session: a
    // missing session must not leave malformed state recoverable forever.
    if (!(await decodeDelegateFlow(record))) {
      await rejectCorruptDelegateFlow(record, {
        kind: "pending",
        sessionKey: record.ownerSessionKey,
      });
      continue;
    }
    sessionKeys.push(record.ownerSessionKey);
  }
  return [...new Set(sessionKeys)].toSorted();
}

/** Decode cutoff-eligible recovery records solely to terminalize malformed state. */
export async function classifyRecoverablePendingDelegates(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): Promise<void> {
  for (const record of await listCutoffEligibleDelegateRecords(options)) {
    if (!(await decodeDelegateFlow(record))) {
      await rejectCorruptDelegateFlow(record, {
        kind: "pending",
        sessionKey: record.ownerSessionKey,
      });
    }
  }
}

/**
 * Claim matured delegates in FIFO order (RFC §5.4.4). The claim records a new,
 * never-reused spawn attempt and its precomputed child run ID in the same
 * commit that marks the record `running`, before anything calls the spawn
 * owner. Records already `running` are never claimed again: a claim that
 * outlived its dispatch is resolved by {@link listUnresolvedDelegateClaims}.
 */
export async function consumePendingDelegates(
  sessionKey: string,
  options: Pick<PendingDelegateCutoffOptions, "queuedCreatedAtOrBefore"> & {
    ignoreDelay?: boolean;
  } = {},
): Promise<PendingContinuationDelegate[]> {
  const delegates: PendingContinuationDelegate[] = [];
  const now = Date.now();
  for (const record of await listQueuedPendingFlows(sessionKey)) {
    if (
      options.queuedCreatedAtOrBefore !== undefined &&
      record.createdAt > options.queuedCreatedAtOrBefore
    ) {
      continue;
    }
    const delegate = await decodeDelegateFlow(record);
    if (!delegate) {
      await rejectCorruptDelegateFlow(record, { kind: "pending", sessionKey });
      continue;
    }
    if (!options.ignoreDelay && now < delegateDueAt(record, delegate)) {
      continue;
    }
    const claimed = await claimContinuationSpawnAttempt({
      recordId: record.recordId,
      ownerSessionKey: sessionKey,
      expectedRevision: record.revision,
      now: Date.now(),
    });
    if (claimed.outcome !== "claimed") {
      continue;
    }
    const claimedDelegate = await decodeDelegateFlow(claimed.record);
    if (claimedDelegate) {
      delegates.push({
        ...claimedDelegate,
        spawnAttempt: {
          attemptId: claimed.attempt.attemptId,
          childRunId: claimed.attempt.childRunId,
        },
      });
    }
  }
  return delegates;
}

/**
 * Claimed delegates whose dispatch did not finish (RFC §5.4.4 boundaries 2-4):
 * `running` records last touched at or before the cutoff. The caller decides
 * each one from `subagent_runs` and never spawns it again (Q3).
 */
export async function listUnresolvedDelegateClaims(
  sessionKey: string,
  options: { updatedAtOrBefore: number },
): Promise<PendingContinuationDelegate[]> {
  const unresolved: PendingContinuationDelegate[] = [];
  for (const record of await listDelegateRecords({
    ownerSessionKey: sessionKey,
    kinds: ["delegate"],
    statuses: ["running"],
  })) {
    if (record.cancelRequestedAt !== undefined || record.updatedAt > options.updatedAtOrBefore) {
      continue;
    }
    const delegate = await decodeDelegateFlowMetadata(record);
    if (!delegate) {
      await rejectCorruptDelegateFlow(record, { kind: "pending", sessionKey });
      continue;
    }
    unresolved.push(delegate);
  }
  return unresolved;
}

async function currentRecordFor(delegate: DelegateRef): Promise<DelegateCustodyRecord | undefined> {
  return delegate.flowId ? await getDelegateRecord(delegate.flowId) : undefined;
}

/**
 * Commit a spawn the Gateway accepted. A pending delegate hands custody to
 * `subagent_runs` permanently (§5.4.4); a released post-compaction record is
 * already handed to its queue entry and only records the accepted child.
 */
export async function markPendingDelegateSpawnAccepted(
  delegate: DelegateRef & Pick<PendingContinuationDelegate, "spawnAttempt">,
  childSessionKey: string,
  options: { requireWriteSuccess?: boolean; childRunId?: string } = {},
): Promise<boolean> {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-accept-missing-flow] cannot commit accepted delegate because flow metadata is missing",
    );
    return false;
  }
  const current = await currentRecordFor(delegate);
  const now = Date.now();
  if (!current) {
    return failAcceptance(delegate, options);
  }
  if (readAcceptedDelegateChildSessionKey(current) === childSessionKey) {
    return true;
  }
  if (isPostCompactionDelegateFlow(current)) {
    const canRecord =
      readAcceptedDelegateChildSessionKey(current) === undefined &&
      (current.revision === delegate.expectedRevision ||
        isDurablyHandedOffPostCompactionFlow(current));
    if (!canRecord) {
      return failAcceptance(delegate, options);
    }
    const recorded = await updateDelegateRecord({
      record: current,
      changes: { childSessionKey },
      patch: {
        phase: "Accepted by continuation subagent",
        ...(current.status === "running" ? { status: "succeeded" as const } : {}),
      },
      now,
    });
    return recorded.applied || failAcceptance(delegate, options);
  }
  if (current.revision !== delegate.expectedRevision || current.status !== "running") {
    return failAcceptance(delegate, options);
  }
  const childRunId =
    options.childRunId ??
    delegate.spawnAttempt?.childRunId ??
    current.spawnAttempts.at(-1)?.childRunId;
  const finished = await updateDelegateRecord({
    record: current,
    changes: { childSessionKey },
    patch: {
      status: "succeeded",
      phase: "Accepted by continuation subagent",
      failureReason: null,
      ...(childRunId
        ? {
            handoff: {
              target: "subagent_runs" as const,
              childRunId,
              childSessionKey,
              handedOffAt: now,
            },
          }
        : {}),
    },
    now,
  });
  return finished.applied || failAcceptance(delegate, options);
}

function failAcceptance(delegate: DelegateRef, options: { requireWriteSuccess?: boolean }): false {
  const message = `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`;
  log.warn(message);
  if (options.requireWriteSuccess === true) {
    throw new Error(message);
  }
  return false;
}

export async function markPendingDelegateFailed(
  delegate: DelegateRef,
  failureReason: string,
  phase = "Delegate spawn failed",
): Promise<boolean> {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-fail-missing-flow] cannot mark consumed delegate failed because flow metadata is missing",
    );
    return false;
  }
  const current = await currentRecordFor(delegate);
  if (!current) {
    return false;
  }
  if (current.status === "failed") {
    return true;
  }
  if (current.revision !== delegate.expectedRevision) {
    return false;
  }
  const failed = await updateDelegateRecord({
    record: current,
    patch: { status: "failed", phase, failureReason },
  });
  return failed.applied || failed.current?.status === "failed";
}

/**
 * Put a claimed delegate back in the queue. Only a claim whose spawn provably
 * never dispatched may be requeued (RFC §5.4.4, "In-process spawn failures");
 * `failurePhase: "initialize"` records that on the claimed attempt.
 */
export async function requeuePendingDelegate(
  delegate: DelegateRef & Pick<PendingContinuationDelegate, "spawnAttempt">,
  phase = "Deferred until continuation is re-enabled",
  inheritedPolicy?: Pick<PendingContinuationDelegate, "inheritedSilent" | "inheritedWake">,
  options: { failurePhase?: "initialize" } = {},
): Promise<boolean> {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return false;
  }
  const current = await currentRecordFor(delegate);
  if (!current || current.revision !== delegate.expectedRevision) {
    return false;
  }
  const currentDelegate = await decodeDelegateFlowMetadata(current);
  const canInheritPolicy = currentDelegate?.mode === undefined || currentDelegate.mode === "normal";
  const changes: DelegateStateChanges = {
    releasedAt: null,
    ...(canInheritPolicy && inheritedPolicy?.inheritedSilent === true
      ? { inheritedSilent: true }
      : {}),
    ...(canInheritPolicy && inheritedPolicy?.inheritedWake === true ? { inheritedWake: true } : {}),
  };
  const stateJson = delegateStateJsonWithChanges(current, changes);
  if (stateJson === undefined) {
    return false;
  }
  const patch: ContinuationRecordPatch = {
    status: "queued",
    phase,
    failureReason: null,
    stateJson,
  };
  const latest = current.spawnAttempts.at(-1);
  if (
    options.failurePhase === "initialize" &&
    latest &&
    latest.attemptId === delegate.spawnAttempt?.attemptId &&
    latest.failurePhase === undefined &&
    current.status === "running"
  ) {
    const result = await recordContinuationSpawnAttemptFailure({
      recordId: current.recordId,
      ownerSessionKey: current.ownerSessionKey,
      expectedRevision: current.revision,
      now: Date.now(),
      attemptId: latest.attemptId,
      failurePhase: "initialize",
      patch,
    });
    return result.outcome === "applied";
  }
  const requeued = await updateDelegateRecord({ record: current, patch });
  return requeued.applied;
}

export async function markPendingDelegateChainStatePersistPlanned(
  delegate: Pick<
    PendingContinuationDelegate,
    | "flowId"
    | "expectedRevision"
    | "task"
    | "persistedChainState"
    | "persistedChainStateKind"
    | "spawnAttempt"
  >,
  chainState: ChainState,
  kind: "advanced" | "terminal" = "advanced",
): Promise<PendingContinuationDelegate> {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-chain-state-plan-missing-flow] cannot mark planned chain state because flow metadata is missing",
    );
    return {
      task: delegate.task,
      ...(delegate.persistedChainState
        ? { persistedChainState: delegate.persistedChainState }
        : {}),
      ...(delegate.persistedChainStateKind
        ? { persistedChainStateKind: delegate.persistedChainStateKind }
        : {}),
    };
  }
  const current = await currentRecordFor(delegate);
  const planned =
    current && current.revision === delegate.expectedRevision
      ? await updateDelegateRecord({
          record: current,
          changes: {
            chainTokensFold: null,
            persistedChainState: chainState,
            persistedChainStateKind: kind,
          },
        })
      : ({ applied: false, reason: "revision_conflict" } satisfies DelegateRecordWriteResult);
  if (!planned.applied) {
    throw new Error(
      `planned delegate chain-state marker was not committed for flow ${delegate.flowId}`,
    );
  }
  const plannedDelegate = await decodeDelegateFlowMetadata(planned.record);
  if (!plannedDelegate) {
    throw new Error(`planned delegate chain-state marker was corrupt for flow ${delegate.flowId}`);
  }
  return {
    ...plannedDelegate,
    ...(delegate.spawnAttempt ? { spawnAttempt: delegate.spawnAttempt } : {}),
  };
}

export async function peekEarliestQueuedDelegateDueAt(
  sessionKey: string,
  options: Pick<PendingDelegateCutoffOptions, "queuedCreatedAtOrBefore"> = {},
): Promise<number | undefined> {
  let soonest: number | undefined;
  for (const record of await listQueuedPendingFlows(sessionKey)) {
    if (
      options.queuedCreatedAtOrBefore !== undefined &&
      record.createdAt > options.queuedCreatedAtOrBefore
    ) {
      continue;
    }
    const delegate = await decodeDelegateFlow(record);
    if (!delegate) {
      await rejectCorruptDelegateFlow(record, { kind: "pending", sessionKey });
      continue;
    }
    const dueAt = delegateDueAt(record, delegate);
    if (soonest === undefined || dueAt < soonest) {
      soonest = dueAt;
    }
  }
  return soonest;
}

/**
 * Authoritative queued-delegate counts for a set of sessions, for readers
 * outside the Gateway process (the CLI status banner) where no hot-path
 * projection was hydrated.
 */
export async function countQueuedDelegatesForSessions(
  sessionKeys: readonly string[],
): Promise<{ pending: number; staged: number }> {
  const owners = new Set(sessionKeys);
  let pending = 0;
  let staged = 0;
  for (const record of await listDelegateRecords({ statuses: ["queued"] })) {
    if (!owners.has(record.ownerSessionKey) || record.cancelRequestedAt !== undefined) {
      continue;
    }
    if (record.kind === "delegate") {
      pending += 1;
    } else {
      staged += 1;
    }
  }
  return { pending, staged };
}

/** Queued pending delegates for a session, from the hot-path projection (display only). */
export function pendingDelegateCount(sessionKey: string): number {
  return countQueuedPendingDelegates(sessionKey);
}

/** Exact queued delegate counts for a correctness decision; never a guessed zero. */
export async function annotateQueuedDelegatesChainTokensFold(
  sessionKey: string,
  chainTokensFold: number,
): Promise<number> {
  if (!(chainTokensFold > 0)) {
    return 0;
  }
  let annotated = 0;
  for (const record of await listQueuedPendingFlows(sessionKey)) {
    if (!decodeDelegateState(record)) {
      continue;
    }
    const result = await updateDelegateRecord({ record, changes: { chainTokensFold } });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

async function clearDelegatesChainTokensFold(
  records: readonly DelegateCustodyRecord[],
): Promise<number> {
  let cleared = 0;
  for (const record of records) {
    if (!decodeDelegateState(record)?.chainTokensFold) {
      continue;
    }
    const result = await updateDelegateRecord({ record, changes: { chainTokensFold: null } });
    if (result.applied) {
      cleared += 1;
    }
  }
  return cleared;
}

export async function clearQueuedDelegatesChainTokensFold(sessionKey: string): Promise<number> {
  return await clearDelegatesChainTokensFold(await listQueuedPendingFlows(sessionKey));
}

export async function clearRecoverableDelegatesChainTokensFold(
  sessionKey: string,
): Promise<number> {
  return await clearDelegatesChainTokensFold(
    (await listLiveDelegateRecords({ ownerSessionKey: sessionKey, kinds: ["delegate"] })).filter(
      (record) => record.cancelRequestedAt === undefined,
    ),
  );
}

export async function annotateQueuedDelegatesInheritedPolicy(
  sessionKey: string,
  policy: { inheritedSilent?: boolean; inheritedWake?: boolean },
  queuedCreatedAtOrBefore?: number,
): Promise<number> {
  if (policy.inheritedSilent !== true && policy.inheritedWake !== true) {
    return 0;
  }
  let annotated = 0;
  for (const record of await listQueuedPendingFlows(sessionKey)) {
    if (queuedCreatedAtOrBefore !== undefined && record.createdAt > queuedCreatedAtOrBefore) {
      continue;
    }
    const state = decodeDelegateState(record);
    // Persisted normal/default mode is represented by omitted mode flags.
    if (!state || state.silent || state.silentWake || state.postCompaction) {
      continue;
    }
    const result = await updateDelegateRecord({
      record,
      changes: {
        ...(policy.inheritedSilent ? { inheritedSilent: true } : {}),
        ...(policy.inheritedWake ? { inheritedWake: true } : {}),
      },
    });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

/** Remove every unclaimed delegate a session queued or staged. */
export async function cancelPendingDelegates(sessionKey: string): Promise<void> {
  for (const record of await listDelegateRecords({
    ownerSessionKey: sessionKey,
    statuses: ["queued"],
  })) {
    await deleteDelegateRecord(record);
  }
}

/** Remove a delegate that was never accepted (RFC §5.4.8 capability 4). */
export async function removeUnacceptedContinuationDelegate(flowId: string): Promise<void> {
  const record = await getDelegateRecord(flowId);
  if (record && record.status === "queued") {
    await deleteDelegateRecord(record);
  }
}

export async function failQueuedDelegatesOwnedByRun(
  sessionKey: string,
  owner: {
    originRunId: string;
    legacyCreatedAfter: number;
  },
  failureReason: string,
): Promise<number> {
  let failed = 0;
  for (const record of await listDelegateRecords({
    ownerSessionKey: sessionKey,
    statuses: ["queued"],
  })) {
    if (!isRecoverableContinuationDelegateFlow(record)) {
      continue;
    }
    const state = decodeDelegateState(record);
    // Current records carry immutable producer identity. Only ownerless
    // records fall back to time, and equality stays untouched because another
    // attempt can begin in the same millisecond.
    const ownedByAttempt =
      state?.originRunId !== undefined
        ? state.originRunId === owner.originRunId
        : record.createdAt > owner.legacyCreatedAfter;
    if (!ownedByAttempt) {
      continue;
    }
    const result = await updateDelegateRecord({
      record,
      patch: {
        status: "failed",
        phase: "Rejected replay-unsafe continuation delegate election",
        failureReason,
      },
    });
    if (result.applied) {
      failed += 1;
    }
  }
  return failed;
}

export function resetDelegateStoreForTests(): void {
  resetDelegateFlowDiagnosticsForTests();
}
