import crypto from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  getDurableJobRegistryObservers,
  getDurableJobRegistryStore,
  resetDurableJobRegistryRuntimeForTests,
  type DurableJobRegistryObserverEvent,
} from "./durable-job-registry.store.js";
import { DURABLE_JOB_STATUSES } from "./durable-job-registry.types.js";
import type {
  DurableJobBacking,
  DurableJobCreateInput,
  DurableJobDispositionNotification,
  DurableJobDispositionWake,
  DurableJobJsonObject,
  DurableJobNotifyPolicy,
  DurableJobRecord,
  DurableJobSource,
  DurableJobStatus,
  DurableJobStopCondition,
  DurableJobTransitionDisposition,
  DurableJobTransitionDispositionInput,
  DurableJobTransitionInput,
  DurableJobTransitionRecord,
  DurableJobUpdateInput,
} from "./durable-job-registry.types.js";

const DURABLE_JOB_STATUS_SET = new Set<DurableJobStatus>(DURABLE_JOB_STATUSES);
const DURABLE_JOB_DISPOSITION_REQUIRED_STATUSES = new Set<DurableJobStatus>([
  "waiting",
  "blocked",
  "completed",
  "cancelled",
  "superseded",
]);

const jobs = new Map<string, DurableJobRecord>();
const transitionsByJobId = new Map<string, DurableJobTransitionRecord[]>();
let restoreAttempted = false;
let restoreFailureMessage: string | null = null;

type DurableJobRecordPatch = Partial<
  Pick<
    DurableJobRecord,
    "title" | "goal" | "status" | "stopCondition" | "notifyPolicy" | "requesterOrigin" | "source"
  >
> & {
  currentStep?: string | null;
  summary?: string | null;
  nextWakeAt?: number | null;
  lastUserUpdateAt?: number | null;
  backing?: DurableJobBacking;
  updatedAt?: number;
};

export type DurableJobUpdateResult =
  | {
      applied: true;
      job: DurableJobRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict";
      current?: DurableJobRecord;
    };

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function cloneJsonObject<T extends DurableJobJsonObject | undefined>(value: T): T {
  return cloneStructuredValue(value) as T;
}

function cloneBacking(backing: DurableJobBacking): DurableJobBacking {
  return {
    ...(backing.taskFlowId ? { taskFlowId: backing.taskFlowId } : {}),
    ...(backing.cronJobIds ? { cronJobIds: [...backing.cronJobIds] } : {}),
    ...(backing.childTaskIds ? { childTaskIds: [...backing.childTaskIds] } : {}),
    ...(backing.childSessionKeys ? { childSessionKeys: [...backing.childSessionKeys] } : {}),
  };
}

function cloneDurableJobRecord(record: DurableJobRecord): DurableJobRecord {
  return {
    ...record,
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(record.source ? { source: cloneJsonObject(record.source) } : {}),
    stopCondition: cloneJsonObject(record.stopCondition),
    notifyPolicy: cloneJsonObject(record.notifyPolicy),
    backing: cloneBacking(record.backing),
    audit: { ...record.audit },
  };
}

function cloneDurableJobTransitionRecord(
  record: DurableJobTransitionRecord,
): DurableJobTransitionRecord {
  return {
    ...record,
    ...(record.disposition ? { disposition: cloneJsonObject(record.disposition) } : {}),
  };
}

function snapshotDurableJobRecords(
  source: ReadonlyMap<string, DurableJobRecord>,
): DurableJobRecord[] {
  return [...source.values()].map((record) => cloneDurableJobRecord(record));
}

function snapshotTransitionsByJobId(
  source: ReadonlyMap<string, DurableJobTransitionRecord[]>,
): Map<string, DurableJobTransitionRecord[]> {
  return new Map(
    [...source.entries()].map(([jobId, transitions]) => [
      jobId,
      transitions.map((transition) => cloneDurableJobTransitionRecord(transition)),
    ]),
  );
}

function emitDurableJobRegistryObserverEvent(
  createEvent: () => DurableJobRegistryObserverEvent,
): void {
  const observers = getDurableJobRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
  } catch {
    // Durable job observers are best-effort only.
  }
}

function assertNonEmptyString(value: string | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBacking(backing?: DurableJobBacking): DurableJobBacking {
  return {
    ...(normalizeOptionalString(backing?.taskFlowId)
      ? { taskFlowId: normalizeOptionalString(backing?.taskFlowId)! }
      : {}),
    ...(normalizeStringArray(backing?.cronJobIds)
      ? { cronJobIds: normalizeStringArray(backing?.cronJobIds)! }
      : {}),
    ...(normalizeStringArray(backing?.childTaskIds)
      ? { childTaskIds: normalizeStringArray(backing?.childTaskIds)! }
      : {}),
    ...(normalizeStringArray(backing?.childSessionKeys)
      ? { childSessionKeys: normalizeStringArray(backing?.childSessionKeys)! }
      : {}),
  };
}

function normalizeStopCondition(stopCondition: DurableJobStopCondition): DurableJobStopCondition {
  const kind = assertNonEmptyString(stopCondition?.kind, "Durable job stopCondition.kind");
  return {
    ...cloneJsonObject(stopCondition),
    kind,
    ...(normalizeOptionalString(stopCondition.details)
      ? { details: normalizeOptionalString(stopCondition.details)! }
      : {}),
  };
}

function normalizeNotifyPolicy(notifyPolicy: DurableJobNotifyPolicy): DurableJobNotifyPolicy {
  return {
    ...cloneJsonObject(notifyPolicy),
    kind: assertNonEmptyString(notifyPolicy?.kind, "Durable job notifyPolicy.kind"),
  };
}

function normalizeSource(source?: DurableJobSource): DurableJobSource | undefined {
  if (!source) {
    return undefined;
  }
  return {
    ...cloneJsonObject(source),
    kind: assertNonEmptyString(source.kind, "Durable job source.kind"),
    ...(normalizeOptionalString(source.messageText)
      ? { messageText: normalizeOptionalString(source.messageText)! }
      : {}),
  };
}

function normalizeDispositionNotification(
  notification?: DurableJobDispositionNotification | null,
): DurableJobDispositionNotification | undefined {
  if (!notification) {
    return undefined;
  }
  return {
    status: assertDispositionNotificationStatus(notification.status),
    ...(normalizeOptionalString(notification.detail)
      ? { detail: normalizeOptionalString(notification.detail)! }
      : {}),
  };
}

function normalizeDispositionWake(
  wake?: DurableJobDispositionWake | null,
): DurableJobDispositionWake | undefined {
  if (!wake) {
    return undefined;
  }
  return {
    status: assertDispositionWakeStatus(wake.status),
    ...(normalizeOptionalTimestamp(wake.nextWakeAt) != null
      ? { nextWakeAt: normalizeOptionalTimestamp(wake.nextWakeAt)! }
      : {}),
    ...(normalizeOptionalString(wake.detail)
      ? { detail: normalizeOptionalString(wake.detail)! }
      : {}),
  };
}

function inferDurableJobTransitionDispositionKind(params: {
  notification?: DurableJobDispositionNotification;
  wake?: DurableJobDispositionWake;
}): string | undefined {
  const { notification, wake } = params;
  if (notification && wake) {
    switch (wake.status) {
      case "scheduled":
        return "notify_and_schedule";
      case "cleared":
        return "notify_and_clear_wake";
      case "unchanged":
        return "notify_and_keep_wake";
    }
  }
  if (notification) {
    return "notify_only";
  }
  if (wake) {
    switch (wake.status) {
      case "scheduled":
        return "schedule_only";
      case "cleared":
        return "clear_wake_only";
      case "unchanged":
        return "wake_unchanged";
    }
  }
  return undefined;
}

export function createDurableJobTransitionDisposition(
  params: DurableJobTransitionDispositionInput,
): DurableJobTransitionDisposition | undefined {
  const notification = normalizeDispositionNotification(params.notification);
  const wake = normalizeDispositionWake(params.wake);
  const kind =
    normalizeOptionalString(params.kind) ??
    inferDurableJobTransitionDispositionKind({ notification, wake });
  if (!kind) {
    return undefined;
  }
  return {
    kind,
    ...(notification ? { notification } : {}),
    ...(wake ? { wake } : {}),
  };
}

function normalizeDisposition(
  disposition?: DurableJobTransitionDisposition,
): DurableJobTransitionDisposition | undefined {
  if (!disposition) {
    return undefined;
  }
  return createDurableJobTransitionDisposition({
    ...cloneJsonObject(disposition),
    kind: assertNonEmptyString(disposition.kind, "Durable job disposition.kind"),
    notification: disposition.notification,
    wake: disposition.wake,
  });
}

function assertDispositionNotificationStatus(
  value: DurableJobDispositionNotification["status"],
): "sent" | "skipped" | "failed" {
  if (value === "sent" || value === "skipped" || value === "failed") {
    return value;
  }
  throw new Error(`Unsupported durable job disposition.notification.status: ${String(value)}`);
}

function assertDispositionWakeStatus(
  value: DurableJobDispositionWake["status"],
): "scheduled" | "cleared" | "unchanged" {
  if (value === "scheduled" || value === "cleared" || value === "unchanged") {
    return value;
  }
  throw new Error(`Unsupported durable job disposition.wake.status: ${String(value)}`);
}

export function isDurableJobTransitionDispositionRequired(to: DurableJobStatus): boolean {
  return DURABLE_JOB_DISPOSITION_REQUIRED_STATUSES.has(to);
}

function assertDispositionProvidedForTransition(params: {
  to: DurableJobStatus;
  disposition?: DurableJobTransitionDisposition;
}) {
  if (params.disposition || !isDurableJobTransitionDispositionRequired(params.to)) {
    return;
  }
  throw new Error(`Durable job transition to ${params.to} requires an explicit disposition.`);
}

function normalizeOptionalTimestamp(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStatus(status: DurableJobStatus | undefined): DurableJobStatus {
  const normalized = status ?? "planned";
  if (!DURABLE_JOB_STATUS_SET.has(normalized)) {
    throw new Error(`Unsupported durable job status: ${normalized}`);
  }
  return normalized;
}

function buildDurableJobRecord(params: DurableJobCreateInput): DurableJobRecord {
  const now =
    normalizeOptionalTimestamp(params.updatedAt) ??
    normalizeOptionalTimestamp(params.createdAt) ??
    Date.now();
  return {
    jobId: normalizeOptionalString(params.jobId) ?? `job_${crypto.randomUUID()}`,
    title: assertNonEmptyString(params.title, "Durable job title"),
    goal: assertNonEmptyString(params.goal, "Durable job goal"),
    ownerSessionKey: assertNonEmptyString(params.ownerSessionKey, "Durable job ownerSessionKey"),
    ...(params.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin)! }
      : {}),
    ...(normalizeSource(params.source) ? { source: normalizeSource(params.source)! } : {}),
    status: normalizeStatus(params.status),
    stopCondition: normalizeStopCondition(params.stopCondition),
    notifyPolicy: normalizeNotifyPolicy(params.notifyPolicy),
    ...(normalizeOptionalString(params.currentStep)
      ? { currentStep: normalizeOptionalString(params.currentStep)! }
      : {}),
    ...(normalizeOptionalString(params.summary)
      ? { summary: normalizeOptionalString(params.summary)! }
      : {}),
    ...(normalizeOptionalTimestamp(params.nextWakeAt) != null
      ? { nextWakeAt: normalizeOptionalTimestamp(params.nextWakeAt)! }
      : {}),
    ...(normalizeOptionalTimestamp(params.lastUserUpdateAt) != null
      ? { lastUserUpdateAt: normalizeOptionalTimestamp(params.lastUserUpdateAt)! }
      : {}),
    backing: normalizeBacking(params.backing),
    audit: {
      createdAt: normalizeOptionalTimestamp(params.createdAt) ?? now,
      updatedAt: now,
      ...(normalizeOptionalString(params.createdBy)
        ? { createdBy: normalizeOptionalString(params.createdBy)! }
        : {}),
      revision: Math.max(0, params.revision ?? 0),
    },
  };
}

function applyDurableJobPatch(
  current: DurableJobRecord,
  patch: DurableJobRecordPatch,
): DurableJobRecord {
  const updatedAt = normalizeOptionalTimestamp(patch.updatedAt) ?? Date.now();
  return {
    ...current,
    ...(patch.title !== undefined
      ? { title: assertNonEmptyString(patch.title, "Durable job title") }
      : {}),
    ...(patch.goal !== undefined
      ? { goal: assertNonEmptyString(patch.goal, "Durable job goal") }
      : {}),
    ...(patch.requesterOrigin !== undefined
      ? { requesterOrigin: cloneStructuredValue(patch.requesterOrigin) }
      : {}),
    ...(patch.source !== undefined ? { source: normalizeSource(patch.source) } : {}),
    ...(patch.status !== undefined ? { status: normalizeStatus(patch.status) } : {}),
    ...(patch.stopCondition !== undefined
      ? { stopCondition: normalizeStopCondition(patch.stopCondition) }
      : {}),
    ...(patch.notifyPolicy !== undefined
      ? { notifyPolicy: normalizeNotifyPolicy(patch.notifyPolicy) }
      : {}),
    ...(patch.currentStep !== undefined
      ? { currentStep: normalizeOptionalString(patch.currentStep) }
      : {}),
    ...(patch.summary !== undefined ? { summary: normalizeOptionalString(patch.summary) } : {}),
    ...(patch.nextWakeAt !== undefined
      ? { nextWakeAt: normalizeOptionalTimestamp(patch.nextWakeAt) }
      : {}),
    ...(patch.lastUserUpdateAt !== undefined
      ? { lastUserUpdateAt: normalizeOptionalTimestamp(patch.lastUserUpdateAt) }
      : {}),
    ...(patch.backing !== undefined ? { backing: normalizeBacking(patch.backing) } : {}),
    audit: {
      ...current.audit,
      updatedAt,
      revision: current.audit.revision + 1,
    },
  };
}

function ensureDurableJobRegistryReady() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getDurableJobRegistryStore().loadSnapshot();
    jobs.clear();
    for (const [jobId, job] of restored.jobs) {
      jobs.set(jobId, cloneDurableJobRecord(job));
    }
    transitionsByJobId.clear();
    for (const [jobId, transitions] of restored.transitionsByJobId) {
      transitionsByJobId.set(
        jobId,
        transitions.map((transition) => cloneDurableJobTransitionRecord(transition)),
      );
    }
    restoreFailureMessage = null;
  } catch (error) {
    jobs.clear();
    transitionsByJobId.clear();
    restoreFailureMessage = formatErrorMessage(error);
    return;
  }
  emitDurableJobRegistryObserverEvent(() => ({
    kind: "restored",
    jobs: snapshotDurableJobRecords(jobs),
    transitionsByJobId: snapshotTransitionsByJobId(transitionsByJobId),
  }));
}

export function getDurableJobRegistryRestoreFailure(): string | null {
  ensureDurableJobRegistryReady();
  return restoreFailureMessage;
}

function persistDurableJobRegistry() {
  getDurableJobRegistryStore().saveSnapshot({
    jobs: new Map(snapshotDurableJobRecords(jobs).map((job) => [job.jobId, job])),
    transitionsByJobId: snapshotTransitionsByJobId(transitionsByJobId),
  });
}

function persistDurableJobUpsert(job: DurableJobRecord) {
  const store = getDurableJobRegistryStore();
  if (store.upsertJob) {
    store.upsertJob(cloneDurableJobRecord(job));
    return;
  }
  persistDurableJobRegistry();
}

function persistDurableJobDelete(jobId: string) {
  const store = getDurableJobRegistryStore();
  if (store.deleteJob) {
    store.deleteJob(jobId);
    return;
  }
  persistDurableJobRegistry();
}

function persistDurableJobTransitionAppend(transition: DurableJobTransitionRecord) {
  const store = getDurableJobRegistryStore();
  if (store.appendTransition) {
    store.appendTransition(cloneDurableJobTransitionRecord(transition));
    return;
  }
  persistDurableJobRegistry();
}

function writeDurableJobRecord(
  next: DurableJobRecord,
  previous?: DurableJobRecord,
): DurableJobRecord {
  ensureDurableJobRegistryReady();
  jobs.set(next.jobId, cloneDurableJobRecord(next));
  persistDurableJobUpsert(next);
  emitDurableJobRegistryObserverEvent(() => ({
    kind: "upserted",
    job: cloneDurableJobRecord(next),
    ...(previous ? { previous: cloneDurableJobRecord(previous) } : {}),
  }));
  return cloneDurableJobRecord(next);
}

export function createDurableJobRecord(params: DurableJobCreateInput): DurableJobRecord {
  ensureDurableJobRegistryReady();
  const record = buildDurableJobRecord(params);
  return writeDurableJobRecord(record);
}

export function updateDurableJobRecordByIdExpectedRevision(params: {
  jobId: string;
  expectedRevision: number;
  patch: DurableJobUpdateInput;
  updatedAt?: number;
}): DurableJobUpdateResult {
  ensureDurableJobRegistryReady();
  const current = jobs.get(params.jobId);
  if (!current) {
    return { applied: false, reason: "not_found" };
  }
  if (current.audit.revision !== params.expectedRevision) {
    return {
      applied: false,
      reason: "revision_conflict",
      current: cloneDurableJobRecord(current),
    };
  }
  const next = applyDurableJobPatch(current, {
    ...params.patch,
    updatedAt: params.updatedAt,
  });
  return {
    applied: true,
    job: writeDurableJobRecord(next, current),
  };
}

export function recordDurableJobTransition(
  params: DurableJobTransitionInput,
): DurableJobTransitionRecord {
  ensureDurableJobRegistryReady();
  const to = normalizeStatus(params.to);
  const disposition = normalizeDisposition(params.disposition);
  assertDispositionProvidedForTransition({
    to,
    disposition,
  });
  const transition: DurableJobTransitionRecord = {
    transitionId: normalizeOptionalString(params.transitionId) ?? `jobtx_${crypto.randomUUID()}`,
    jobId: assertNonEmptyString(params.jobId, "Durable job transition jobId"),
    ...(params.from ? { from: normalizeStatus(params.from) } : {}),
    to,
    ...(normalizeOptionalString(params.reason)
      ? { reason: normalizeOptionalString(params.reason)! }
      : {}),
    at: normalizeOptionalTimestamp(params.at) ?? Date.now(),
    ...(normalizeOptionalString(params.actor)
      ? { actor: normalizeOptionalString(params.actor)! }
      : {}),
    ...(disposition ? { disposition } : {}),
    ...(typeof params.revision === "number" && Number.isFinite(params.revision)
      ? { revision: params.revision }
      : {}),
  };
  const existing = transitionsByJobId.get(transition.jobId);
  if (existing) {
    existing.push(cloneDurableJobTransitionRecord(transition));
  } else {
    transitionsByJobId.set(transition.jobId, [cloneDurableJobTransitionRecord(transition)]);
  }
  persistDurableJobTransitionAppend(transition);
  emitDurableJobRegistryObserverEvent(() => ({
    kind: "transition_appended",
    transition: cloneDurableJobTransitionRecord(transition),
  }));
  return cloneDurableJobTransitionRecord(transition);
}

export function getDurableJobById(jobId: string): DurableJobRecord | undefined {
  ensureDurableJobRegistryReady();
  const record = jobs.get(jobId);
  return record ? cloneDurableJobRecord(record) : undefined;
}

export function listDurableJobRecords(): DurableJobRecord[] {
  ensureDurableJobRegistryReady();
  return [...jobs.values()]
    .slice()
    .toSorted((left, right) => {
      if (left.audit.updatedAt !== right.audit.updatedAt) {
        return right.audit.updatedAt - left.audit.updatedAt;
      }
      return left.jobId.localeCompare(right.jobId);
    })
    .map((record) => cloneDurableJobRecord(record));
}

export function listDurableJobTransitions(jobId: string): DurableJobTransitionRecord[] {
  ensureDurableJobRegistryReady();
  return (transitionsByJobId.get(jobId) ?? []).map((transition) =>
    cloneDurableJobTransitionRecord(transition),
  );
}

export function deleteDurableJobRecordById(jobId: string): boolean {
  ensureDurableJobRegistryReady();
  const previous = jobs.get(jobId);
  if (!previous) {
    return false;
  }
  jobs.delete(jobId);
  transitionsByJobId.delete(jobId);
  persistDurableJobDelete(jobId);
  emitDurableJobRegistryObserverEvent(() => ({
    kind: "deleted",
    jobId,
    previous: cloneDurableJobRecord(previous),
  }));
  return true;
}

export function resetDurableJobRegistryForTests(opts?: { persist?: boolean }) {
  jobs.clear();
  transitionsByJobId.clear();
  restoreAttempted = false;
  restoreFailureMessage = null;
  if (opts?.persist === false) {
    return;
  }
  getDurableJobRegistryStore().saveSnapshot({
    jobs: new Map(),
    transitionsByJobId: new Map(),
  });
  resetDurableJobRegistryRuntimeForTests();
}
