/**
 * Continuation delegate custody records (RFC docs/design/continue-work-signal-v2.md
 * §5.4.2). Pending (`delegate`) and post-compaction (`post_compaction`) delegates
 * live in the continuation custody store; this module is their codec and their
 * record-level reads and writes. A record's ID is the delegate's `flowId`: the
 * Doctor import keeps `record_id = flow_id` (§5.4.5), and every durable key that
 * names a delegate (queue `sourceFlowId`, artifact policies, derived child keys)
 * still spells it that way.
 */
import crypto from "node:crypto";
import { validateSubagentAttachments } from "../../agents/subagents/spawn/subagent-attachments.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerDiagnosticContinuationQueueMetricsProvider } from "../../logging/diagnostic-continuation-queues.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadContinuationCustodyPayload } from "./custody/custody-payload-store.js";
import {
  readContinuationCustodySnapshot,
  readContinuationLiveWork,
} from "./custody/custody-projection.js";
import {
  createContinuationRecord,
  deleteContinuationRecord,
  listContinuationRecords,
  newContinuationRecordId,
  resolveContinuationCustodyDatabasePath,
  updateContinuationRecords,
  whenContinuationCustodyReady,
} from "./custody/custody-store.js";
import type {
  ContinuationRecord,
  ContinuationRecordKind,
  ContinuationRecordPatch,
  ContinuationRecordStatus,
  ContinuationUpdateResult,
} from "./custody/custody-store.types.js";
import { captureContinuationDelegateDispatchGrant } from "./delegate-dispatch-grant.js";
import * as delegateFlowDiagnostics from "./delegate-flow-diagnostics.js";
import {
  decodeDelegateStateJson,
  encodeDelegateState,
  type PendingDelegateState,
} from "./delegate-flow-state.js";
import { createContinuationRecipientAuthorityBinding } from "./recipient-authority-binding.js";
import type { ChainState, PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");

/** A pending or post-compaction delegate record. */
export type DelegateCustodyRecord = ContinuationRecord & {
  kind: Extract<ContinuationRecordKind, "delegate" | "post_compaction">;
};

export type PendingDelegateCutoffOptions = {
  includeRunning?: boolean;
  queuedCreatedAtOrBefore?: number;
  includeRunningUpdatedAtOrBefore?: number;
};

type ContinuationDelegateQueueDepths = {
  pendingQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  totalQueued: number;
};

export type DelegateStateChanges = {
  releasedAt?: number | null;
  childSessionKey?: string | null;
  chainTokensFold?: number | null;
  persistedChainState?: ChainState | null;
  persistedChainStateKind?: "advanced" | "terminal" | null;
  inheritedSilent?: true;
  inheritedWake?: true;
  awaitingNextCompaction?: true | null;
};

const DELEGATE_KINDS = ["delegate", "post_compaction"] as const;
const LIVE_STATUSES = ["queued", "running"] as const satisfies readonly ContinuationRecordStatus[];

function isContinuationDelegateRecord(record: ContinuationRecord): record is DelegateCustodyRecord {
  return record.kind === "delegate" || record.kind === "post_compaction";
}

export function isPendingDelegateFlow(record: ContinuationRecord): boolean {
  return record.kind === "delegate";
}

export function isPostCompactionDelegateFlow(record: ContinuationRecord): boolean {
  return record.kind === "post_compaction";
}

export function isTerminalDelegateFlow(record: ContinuationRecord): boolean {
  return (
    isContinuationDelegateRecord(record) &&
    (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled")
  );
}

/** True while a post-compaction record sits handed off to the session queue (§4.4). */
export function isDurablyHandedOffPostCompactionFlow(
  record: ContinuationRecord | undefined,
): boolean {
  return (
    record !== undefined &&
    isPostCompactionDelegateFlow(record) &&
    record.status === "succeeded" &&
    record.handoff?.target === "session_delivery_queue"
  );
}

export function isRecoverableContinuationDelegateFlow(record: ContinuationRecord): boolean {
  return (
    isContinuationDelegateRecord(record) &&
    record.cancelRequestedAt === undefined &&
    (record.status === "queued" || record.status === "running")
  );
}

export function isRecoverablePendingFlowWithinCutoffs(
  record: ContinuationRecord,
  options: PendingDelegateCutoffOptions = {},
): boolean {
  if (!isPendingDelegateFlow(record) || record.cancelRequestedAt !== undefined) {
    return false;
  }
  if (record.status === "queued") {
    return (
      options.queuedCreatedAtOrBefore === undefined ||
      record.createdAt <= options.queuedCreatedAtOrBefore
    );
  }
  if (record.status !== "running" || options.includeRunning !== true) {
    return false;
  }
  return (
    options.includeRunningUpdatedAtOrBefore === undefined ||
    record.updatedAt <= options.includeRunningUpdatedAtOrBefore
  );
}

export function decodeDelegateState(record: ContinuationRecord): PendingDelegateState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.stateJson);
  } catch {
    return undefined;
  }
  return decodeDelegateStateJson(parsed);
}

function projectDelegate(
  record: ContinuationRecord,
  state: PendingDelegateState,
  payload: { attachments?: PendingContinuationDelegate["attachments"]; attachAs?: unknown },
): PendingContinuationDelegate {
  const attachments = payload.attachments ?? state.attachments;
  const attachAs =
    // SAFETY: loadContinuationCustodyPayload parsed attachAs with the strict mount schema.
    (payload.attachAs as PendingDelegateState["attachAs"]) ?? state.attachAs;
  const mode =
    state.postCompaction === true || record.kind === "post_compaction"
      ? "post-compaction"
      : state.silentWake === true
        ? "silent-wake"
        : state.silent === true
          ? "silent"
          : undefined;
  return {
    task: state.task,
    ...(state.delayMs !== undefined ? { delayMs: state.delayMs } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(state.firstArmedAt !== undefined ? { firstArmedAt: state.firstArmedAt } : {}),
    ...(attachments ? { attachments: structuredClone(attachments) } : {}),
    ...(attachAs ? { attachAs: { ...attachAs } } : {}),
    ...(state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {}),
    ...(state.targetSessionKeys?.length ? { targetSessionKeys: state.targetSessionKeys } : {}),
    ...(state.fanoutMode ? { fanoutMode: state.fanoutMode } : {}),
    ...(state.recipientAuthorityBinding
      ? { recipientAuthorityBinding: state.recipientAuthorityBinding }
      : {}),
    ...(state.traceparent && state.traceparentProvenance === "internal"
      ? { traceparent: state.traceparent }
      : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.chainTokensFold !== undefined ? { chainTokensFold: state.chainTokensFold } : {}),
    ...(state.persistedChainState ? { persistedChainState: state.persistedChainState } : {}),
    ...(state.persistedChainStateKind
      ? { persistedChainStateKind: state.persistedChainStateKind }
      : {}),
    ...(state.inheritedSilent ? { inheritedSilent: true } : {}),
    ...(state.inheritedWake ? { inheritedWake: true } : {}),
    ...(state.originRunId ? { originRunId: state.originRunId } : {}),
    ...(state.dispatchGrant ? { dispatchGrant: state.dispatchGrant } : {}),
    flowId: record.recordId,
    expectedRevision: record.revision,
    ...(record.spawnAttempts.length > 0
      ? { recordedChildRunIds: record.spawnAttempts.map((attempt) => attempt.childRunId) }
      : {}),
  };
}

async function decodeDelegateFlowWithOptions(
  record: ContinuationRecord,
  options: { requireAttachmentPayload: boolean },
): Promise<PendingContinuationDelegate | undefined> {
  const state = decodeDelegateState(record);
  if (!state) {
    return undefined;
  }
  const payload = record.attachmentId
    ? await loadContinuationCustodyPayload(record.attachmentId, {
        recordId: record.recordId,
        ownerKey: record.ownerSessionKey,
      })
    : undefined;
  const delegate = projectDelegate(record, state, payload ?? {});
  if (
    options.requireAttachmentPayload &&
    state.attachmentCount !== undefined &&
    delegate.attachments?.length !== state.attachmentCount
  ) {
    return undefined;
  }
  // Apply the live spawn policy to the durable snapshot. Invalid recovery state
  // never reaches dispatch (§9.2.1 item 3).
  const attachmentError = validateSubagentAttachments({
    config: getRuntimeConfig(),
    attachments: delegate.attachments,
    continuationDelegateSnapshot: true,
  });
  return attachmentError ? undefined : delegate;
}

/** Decode a record for dispatch; referenced attachment bytes must be present. */
export function decodeDelegateFlow(
  record: ContinuationRecord,
): Promise<PendingContinuationDelegate | undefined> {
  return decodeDelegateFlowWithOptions(record, { requireAttachmentPayload: true });
}

/** Decode a record whose attachment custody may already be released (terminal or handed off). */
export function decodeDelegateFlowMetadata(
  record: ContinuationRecord,
): Promise<PendingContinuationDelegate | undefined> {
  return decodeDelegateFlowWithOptions(record, { requireAttachmentPayload: false });
}

export function readAcceptedDelegateChildSessionKey(
  record: ContinuationRecord,
): string | undefined {
  if (record.handoff?.target === "subagent_runs") {
    return record.handoff.childSessionKey;
  }
  return decodeDelegateState(record)?.childSessionKey;
}

export function isAwaitingNextCompactionDelegateFlow(record: ContinuationRecord): boolean {
  return decodeDelegateState(record)?.awaitingNextCompaction === true;
}

export function delegateDueAt(
  record: ContinuationRecord,
  delegate: Pick<PendingContinuationDelegate, "delayMs">,
): number {
  return record.createdAt + (delegate.delayMs ?? 0);
}

function applyDelegateStateChanges(
  state: PendingDelegateState,
  changes: DelegateStateChanges = {},
): PendingDelegateState {
  const next = { ...state };
  for (const key of [
    "releasedAt",
    "childSessionKey",
    "chainTokensFold",
    "persistedChainState",
    "persistedChainStateKind",
    "inheritedSilent",
    "inheritedWake",
    "awaitingNextCompaction",
  ] as const) {
    const value = changes[key];
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      Object.assign(next, { [key]: value });
    }
  }
  return next;
}

/** State JSON as stored: attachment bytes live only in the payload file. */
function encodeStoredDelegateState(state: PendingDelegateState): string {
  const { attachments: _attachments, attachAs: _attachAs, attachmentId: _id, ...rest } = state;
  return JSON.stringify(rest);
}

/** List delegate records, FIFO by creation. */
export async function listDelegateRecords(query: {
  ownerSessionKey?: string;
  kinds?: readonly DelegateCustodyRecord["kind"][];
  statuses?: readonly ContinuationRecordStatus[];
  recordIds?: readonly string[];
}): Promise<DelegateCustodyRecord[]> {
  const records = await listContinuationRecords({
    ...query,
    kinds: query.kinds ?? DELEGATE_KINDS,
  });
  return records.filter(isContinuationDelegateRecord);
}

export async function listLiveDelegateRecords(
  query: { ownerSessionKey?: string; kinds?: readonly DelegateCustodyRecord["kind"][] } = {},
): Promise<DelegateCustodyRecord[]> {
  return await listDelegateRecords({ ...query, statuses: LIVE_STATUSES });
}

export async function getDelegateRecord(
  recordId: string,
): Promise<DelegateCustodyRecord | undefined> {
  return (await listDelegateRecords({ recordIds: [recordId] }))[0];
}

export async function listQueuedPendingFlows(sessionKey: string): Promise<DelegateCustodyRecord[]> {
  return (
    await listDelegateRecords({
      ownerSessionKey: sessionKey,
      kinds: ["delegate"],
      statuses: ["queued"],
    })
  ).filter((record) => record.cancelRequestedAt === undefined);
}

export async function listQueuedPostCompactionFlows(
  sessionKey: string,
): Promise<DelegateCustodyRecord[]> {
  return (
    await listDelegateRecords({
      ownerSessionKey: sessionKey,
      kinds: ["post_compaction"],
      statuses: ["queued"],
    })
  ).filter((record) => record.cancelRequestedAt === undefined);
}

function describeUpdateFailure(result: ContinuationUpdateResult): string {
  return result.outcome === "applied" ? "applied" : result.outcome;
}

export type DelegateRecordWriteResult =
  | { applied: true; record: DelegateCustodyRecord }
  | { applied: false; reason: string; current?: DelegateCustodyRecord };

async function writeDelegateRecord(
  record: DelegateCustodyRecord,
  patch: ContinuationRecordPatch,
  now: number,
): Promise<DelegateRecordWriteResult> {
  const result = await updateContinuationRecords(
    [
      {
        recordId: record.recordId,
        ownerSessionKey: record.ownerSessionKey,
        expectedRevision: record.revision,
        patch,
      },
    ],
    { now },
  );
  if (result.outcome === "applied") {
    const next = result.records[0];
    if (next && isContinuationDelegateRecord(next)) {
      return { applied: true, record: next };
    }
  }
  return {
    applied: false,
    reason: describeUpdateFailure(result),
    current:
      result.outcome === "revision_conflict" ? await getDelegateRecord(record.recordId) : undefined,
  };
}

/** The record's stored state JSON with `changes` applied; undefined when it cannot decode. */
export function delegateStateJsonWithChanges(
  record: ContinuationRecord,
  changes: DelegateStateChanges,
): string | undefined {
  const state = decodeDelegateState(record);
  return state ? encodeStoredDelegateState(applyDelegateStateChanges(state, changes)) : undefined;
}

/**
 * One CAS write on a delegate record: state changes are applied to the
 * record's current state JSON, never to a caller-held copy.
 */
export async function updateDelegateRecord(params: {
  record: DelegateCustodyRecord;
  changes?: DelegateStateChanges;
  patch?: ContinuationRecordPatch;
  now?: number;
}): Promise<DelegateRecordWriteResult> {
  const stateJson = params.changes
    ? delegateStateJsonWithChanges(params.record, params.changes)
    : undefined;
  if (params.changes && stateJson === undefined) {
    return { applied: false, reason: "undecodable_state" };
  }
  return await writeDelegateRecord(
    params.record,
    { ...params.patch, ...(stateJson !== undefined ? { stateJson } : {}) },
    params.now ?? Date.now(),
  );
}

export async function createDelegateRecord(params: {
  ownerKey: string;
  controller: "pending" | "post-compaction";
  delegate: PendingContinuationDelegate;
  phase: string;
  /** Tests and non-tool producers can inject their resolved runtime policy. */
  attachmentConfig?: OpenClawConfig;
  now?: number;
}): Promise<DelegateCustodyRecord> {
  const createdAt = params.now ?? Date.now();
  const delegate = {
    ...params.delegate,
    // Bound before the record exists: a failed capture commits no record, never an unbound one.
    recipientAuthorityBinding:
      params.delegate.recipientAuthorityBinding ??
      (await createContinuationRecipientAuthorityBinding({
        requesterSessionKey: params.ownerKey,
        targetSessionKey: params.delegate.targetSessionKey,
        targetSessionKeys: params.delegate.targetSessionKeys,
        fanoutMode: params.delegate.fanoutMode,
      })),
    // Only the electing request grants; a caller-supplied grant is never persisted.
    dispatchGrant:
      params.controller === "pending"
        ? await captureContinuationDelegateDispatchGrant({
            ownerSessionKey: params.ownerKey,
            dueAt: createdAt + (params.delegate.delayMs ?? 0),
          })
        : undefined,
  };
  const state = encodeDelegateState(delegate, params.attachmentConfig);
  const recordId = newContinuationRecordId();
  const attachmentId = state.attachments ? crypto.randomUUID() : undefined;
  const kind = params.controller === "post-compaction" ? "post_compaction" : "delegate";
  const result = await createContinuationRecord(
    {
      recordId,
      kind,
      ownerSessionKey: params.ownerKey,
      status: "queued",
      phase: params.phase,
      createdAt,
      // The derived due-time copy for recovery scans; delegates are due at
      // `created_at + delayMs`. Staged post-compaction work has no due time.
      ...(kind === "delegate" ? { dueAt: createdAt + (state.delayMs ?? 0) } : {}),
      stateJson: encodeStoredDelegateState(state),
      ...(attachmentId ? { attachmentId } : {}),
    },
    attachmentId && state.attachments
      ? {
          payload: {
            attachments: state.attachments,
            ...(state.attachAs ? { attachAs: state.attachAs } : {}),
          },
        }
      : undefined,
  );
  if (result.outcome !== "created" || !isContinuationDelegateRecord(result.record)) {
    throw new Error(
      `continuation delegate custody was not committed (${result.outcome}) for ${params.ownerKey}`,
    );
  }
  return result.record;
}

export async function deleteDelegateRecord(record: DelegateCustodyRecord): Promise<boolean> {
  const result = await deleteContinuationRecord({
    recordId: record.recordId,
    ownerSessionKey: record.ownerSessionKey,
    expectedRevision: record.revision,
  });
  return result.outcome === "deleted";
}

export async function rejectCorruptDelegateFlow(
  record: DelegateCustodyRecord,
  options: { kind: "pending" | "post-compaction"; sessionKey: string },
): Promise<void> {
  const isPostCompaction = options.kind === "post-compaction";
  const tag = isPostCompaction
    ? "continuation:post-compaction-decode-failed"
    : "continuation:delegate-decode-failed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.stateJson);
  } catch {
    parsed = undefined;
  }
  log.warn(
    `[${tag}] flowId=${record.recordId} session=${options.sessionKey} ${delegateFlowDiagnostics.describeDelegateState(parsed)}`,
  );
  await writeDelegateRecord(
    record,
    {
      status: "failed",
      stateJson: "{}",
      phase: isPostCompaction
        ? "Rejected invalid post-compaction payload"
        : "Rejected invalid continuation payload",
      failureReason: isPostCompaction
        ? "Staged post-compaction delegate payload could not be decoded."
        : "Pending continuation delegate payload could not be decoded.",
    },
    Date.now(),
  );
}

/**
 * Startup payload reconcile: remove payload files that no live record
 * references (§5.4.4 crash boundary 0).
 */
export async function reconcileDelegateAttachmentCustody(
  orphanedBefore: number,
): Promise<{ removed: number; failed: number }> {
  const { reconcileContinuationCustodyPayloads } =
    await import("./custody/custody-payload-store.js");
  const retainedAttachmentIds = new Set<string>();
  for (const record of await listLiveDelegateRecords()) {
    if (record.attachmentId) {
      retainedAttachmentIds.add(record.attachmentId);
    }
  }
  return await reconcileContinuationCustodyPayloads({ retainedAttachmentIds, orphanedBefore });
}

function readOwnerLiveDelegateFacts(sessionKey: string) {
  const answer = readContinuationLiveWork(
    resolveContinuationCustodyDatabasePath(),
    sessionKey,
    DELEGATE_KINDS,
  );
  return answer.state === "known" ? answer.records : undefined;
}

/** Queued pending delegates for a session, from the hot-path projection (§5.4.6). */
export function countQueuedPendingDelegates(sessionKey: string): number {
  return (readOwnerLiveDelegateFacts(sessionKey) ?? []).filter(
    (fact) => fact.kind === "delegate" && fact.status === "queued" && !fact.cancelRequested,
  ).length;
}

/** Staged post-compaction delegates for a session, from the hot-path projection. */
export function countStagedPostCompactionDelegates(sessionKey: string): number {
  return (readOwnerLiveDelegateFacts(sessionKey) ?? []).filter(
    (fact) => fact.kind === "post_compaction" && fact.status === "queued" && !fact.cancelRequested,
  ).length;
}

/** Queued delegate counts. */
export type QueuedDelegateCounts = {
  pending: number;
  stagedPostCompaction: number;
};

type DelegateFact = { kind: ContinuationRecordKind; status: string; cancelRequested: boolean };

/**
 * Queued delegate counts for a correctness decision (RFC §5.4.6). Before
 * hydration this waits for custody phase A. After that it is the projection
 * when it knows the owner, and otherwise (an unresolved write) the owner's
 * committed rows. A decision never reads `unknown` as zero.
 */
export async function resolveQueuedDelegateCounts(
  sessionKey: string,
): Promise<QueuedDelegateCounts> {
  if (readOwnerLiveDelegateFacts(sessionKey) === undefined) {
    await whenContinuationCustodyReady();
  }
  let facts: readonly DelegateFact[] | undefined = readOwnerLiveDelegateFacts(sessionKey);
  if (!facts) {
    const records = await listContinuationRecords({
      ownerSessionKey: sessionKey,
      kinds: DELEGATE_KINDS,
      statuses: ["queued"],
    });
    facts = records.map((record) => ({
      kind: record.kind,
      status: record.status,
      cancelRequested: record.cancelRequestedAt !== undefined,
    }));
  }
  const queued = facts.filter((fact) => fact.status === "queued" && !fact.cancelRequested);
  const pending = queued.filter((fact) => fact.kind === "delegate").length;
  return { pending, stagedPostCompaction: queued.length - pending };
}

const continuationQueueDiagnostics = delegateFlowDiagnostics.createContinuationQueueDiagnostics({
  readSnapshot: () => readContinuationCustodySnapshot(resolveContinuationCustodyDatabasePath()),
});

registerDiagnosticContinuationQueueMetricsProvider(continuationQueueDiagnostics.sample);

export function getContinuationDelegateQueueDepths(
  sessionKey: string,
  now = Date.now(),
): ContinuationDelegateQueueDepths {
  const facts = (readOwnerLiveDelegateFacts(sessionKey) ?? []).filter(
    (fact) => fact.status === "queued" && !fact.cancelRequested,
  );
  const pending = facts.filter((fact) => fact.kind === "delegate");
  const pendingRunnable = pending.filter((fact) => (fact.dueAt ?? fact.createdAt) <= now).length;
  const stagedPostCompaction = facts.length - pending.length;
  return {
    pendingQueued: pending.length,
    pendingRunnable,
    pendingScheduled: pending.length - pendingRunnable,
    stagedPostCompaction,
    totalQueued: facts.length,
  };
}

export function resetDelegateFlowDiagnosticsForTests(): void {
  continuationQueueDiagnostics.reset();
}
