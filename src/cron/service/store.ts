/** Loads, normalizes, quarantines, and persists cron service store state. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { captureCronMutationCommit } from "../mutation-completion.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  getCronJobsStoreRevision,
  noteCronJobsStoreCommit,
  loadCronJobsStoreWithConfigJobs,
  saveCronJobsStoreWithRevision,
  type QuarantinedCronConfigJob,
} from "../store.js";
import {
  CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
  hasCanonicalCronDeliveryMode,
} from "../store/delivery-codec.js";
import { publishCronJobNames } from "../store/job-name.js";
import { cronStoreKey } from "../store/key.js";
import { assertCronStoreCanPersist } from "../store/row-codec.js";
import {
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
} from "../store/run-receipt-store.js";
import type { CronRuntimeMutationInputs } from "../store/runtime-worker.types.js";
import { CronJobsStoreChangedError } from "../store/save-error.js";
import { prepareCronStoreChanges } from "../store/save.kernel.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { assertTimeScheduleSatisfiable } from "./jobs-validation.js";
import { dispatchCronNotification } from "./notification-dispatch.js";
import { resolveForcePreservedOneShotAtMs } from "./one-shot-schedule.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { publishDurableNextRunChanges } from "./runtime-publication.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";

const loadedCronStoreRevisions = new WeakMap<
  CronServiceState,
  { revision: number; jobsFingerprint?: string; runtimeFingerprint?: string }
>();

export type CronRollbackSnapshot = {
  store: CronStoreFile | null;
  durableNextRunAtMsByJobId: Map<string, number | undefined>;
};

function invalidateStaleNextRunOnScheduleChange(params: {
  previousJobsById: ReadonlyMap<string, CronJob>;
  hydrated: CronJob;
}) {
  const previousJob = params.previousJobsById.get(params.hydrated.id);
  if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) {
    return;
  }
  // Runtime nextRunAtMs and paced provenance belong to the old scheduling
  // identity; clear them together so the current inputs recompute atomically.
  params.hydrated.state ??= {};
  params.hydrated.state.nextRunAtMs = undefined;
  params.hydrated.state.startupCatchupAtMs = undefined;
  params.hydrated.state.pacedNextRunAtMs = undefined;
  params.hydrated.state.forcePreservedNextRunAtMs = cronSchedulingInputsEqual(
    { ...previousJob, enabled: params.hydrated.enabled },
    params.hydrated,
  )
    ? resolveForcePreservedOneShotAtMs(params.hydrated)
    : undefined;
}

function warnInvalidPersistedCronJob(params: {
  state: CronServiceState;
  raw: Record<string, unknown>;
  index: number;
  reason: string;
}) {
  const jobId = typeof params.raw.id === "string" ? params.raw.id : undefined;
  const dedupeKey = jobId ?? `index:${params.index}`;
  if (params.state.warnedInvalidPersistedJobKeys.has(dedupeKey)) {
    return;
  }
  params.state.warnedInvalidPersistedJobKeys.add(dedupeKey);
  params.state.deps.log.warn(
    {
      storePath: params.state.deps.storePath,
      jobId,
      jobIndex: params.index,
      reason: params.reason,
    },
    "cron: quarantined invalid persisted job and skipped it from runtime",
  );
}

function isValidatedCronJob(
  value: Record<string, unknown>,
): value is CronJob & Record<string, unknown> {
  return getInvalidPersistedCronJobReason(value) === null;
}

/** Loads and normalizes the cron store, quarantining invalid persisted rows before runtime use. */
export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** A disabled writer commits only its changed rows, so quarantine cleanup
     *  must not turn its fresh read back into a full-store replacement. */
    deferQuarantinePersist?: boolean;
  },
) {
  // Keep scheduler-local pacing/catch-up mutations while the publication fact
  // still matches; evicted partitions conservatively use the global sequence.
  if (state.store && !opts?.forceReload) {
    const loadedRevision = loadedCronStoreRevisions.get(state)?.revision;
    if (
      loadedRevision === undefined ||
      loadedRevision === getCronJobsStoreRevision(state.deps.storePath)
    ) {
      return;
    }
  }
  const previousJobsById = new Map<string, CronJob>();
  for (const job of state.store?.jobs ?? []) {
    previousJobsById.set(job.id, job);
  }
  const loadedRevision = getCronJobsStoreRevision(state.deps.storePath);
  const loaded = await loadCronJobsStoreWithConfigJobs(state.deps.storePath);
  const loadNowMs = state.deps.nowMs();
  // Persisted cron rows are validated lazily, so treat them as raw records at the
  // store boundary and only trust the CronJob shape after validation below.
  const loadedJobs = (loaded.store.jobs ?? []).filter(isRecord);
  const jobs: CronJob[] = [];
  const durableNextRunAtMsByJobId = new Map<string, number | undefined>();
  const quarantinedConfigJobs: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  for (const [index, raw] of loadedJobs.entries()) {
    if (!hasCanonicalCronDeliveryMode(raw.delivery)) {
      const warningKey = `delivery:${raw.id}`;
      if (!state.warnedInvalidPersistedJobKeys.has(warningKey)) {
        state.warnedInvalidPersistedJobKeys.add(warningKey);
        state.deps.log.warn(
          { jobId: raw.id },
          `cron: job execution withheld: ${CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE}`,
        );
      }
    }
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const sourceIndex = loaded.configJobIndexes[index] ?? index;
    const runtimeEntry = loaded.configJobRuntimeEntries[index];
    const rawInvalidReason = getInvalidPersistedCronJobReason(raw);
    let normalized: Record<string, unknown> | null;
    try {
      normalized = normalizeCronJobInput(raw);
      if (normalized && raw.delivery !== undefined) {
        normalized.delivery = raw.delivery;
      }
    } catch (error) {
      if (!isInvalidCronSessionTargetIdError(error)) {
        throw error;
      }
      normalized = null;
      state.deps.log.warn(
        { storePath: state.deps.storePath, jobId: typeof raw.id === "string" ? raw.id : undefined },
        "cron: job has invalid persisted sessionTarget; run openclaw doctor --fix to repair",
      );
    }
    const hydratedRaw = normalized ?? raw;
    let invalidReason = rawInvalidReason ?? getInvalidPersistedCronJobReason(hydratedRaw);
    const hydratedSchedule = isRecord(hydratedRaw.schedule) ? hydratedRaw.schedule : {};
    // The satisfiability probe below does not mutate this row, so its typed validation stays valid.
    const hydratedIsValid = !invalidReason && isValidatedCronJob(hydratedRaw);
    if (hydratedIsValid && hydratedRaw.enabled && hydratedSchedule.kind === "every") {
      try {
        assertTimeScheduleSatisfiable({ ...hydratedRaw, state: {} }, loadNowMs);
      } catch {
        invalidReason = "unsatisfiable-schedule";
      }
    }
    if (invalidReason) {
      const quarantineEntry: QuarantinedCronConfigJob = {
        sourceIndex,
        reason: invalidReason,
        job: rawConfigJob,
      };
      const runtimeState = runtimeEntry?.state ?? raw.state;
      if (runtimeState && typeof runtimeState === "object" && !Array.isArray(runtimeState)) {
        // Preserve runtime state with the quarantined config so doctor can
        // repair shape without losing last/next run information.
        quarantineEntry.state = structuredClone(runtimeState as Record<string, unknown>);
      }
      const updatedAtMs = runtimeEntry?.updatedAtMs ?? raw.updatedAtMs;
      if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
        quarantineEntry.updatedAtMs = updatedAtMs;
      }
      if (typeof runtimeEntry?.scheduleIdentity === "string") {
        quarantineEntry.scheduleIdentity = runtimeEntry.scheduleIdentity;
      }
      quarantinedConfigJobs.push(quarantineEntry);
      warnInvalidPersistedCronJob({ state, raw, index: sourceIndex, reason: invalidReason });
      continue;
    }
    // Validated above, so the raw record is now a trusted CronJob.
    if (!hydratedIsValid) {
      continue;
    }
    const hydrated = hydratedRaw;
    jobs.push(hydrated);
    // Capture the value SQLite actually held before schedule-identity repair
    // mutates the runtime view. A later save can then publish that transition.
    durableNextRunAtMsByJobId.set(hydrated.id, hydrated.state.nextRunAtMs);
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.durableNextRunAtMsByJobId = durableNextRunAtMsByJobId;
  state.storeLoadedAtMs = loadNowMs;
  // A writer or load repair during the await leaves this snapshot conservatively stale.
  loadedCronStoreRevisions.set(state, {
    revision: loadedRevision,
    jobsFingerprint: loaded.jobsFingerprint,
    runtimeFingerprint: loaded.runtimeFingerprint,
  });

  if (quarantinedConfigJobs.length > 0 && !opts?.deferQuarantinePersist) {
    // Config decoding and runtime validation reject rows in separate passes;
    // restore their original durable order before writing operator-visible quarantine.
    quarantinedConfigJobs.sort((left, right) => left.sourceIndex - right.sourceIndex);
    state.pendingQuarantineConfigJobs = quarantinedConfigJobs;
    try {
      if (await persistQuarantinedJobs(state, state.store)) {
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            quarantinedJobs: quarantinedConfigJobs.length,
          },
          "cron: sanitized active cron store after quarantining malformed persisted jobs",
        );
      }
    } catch (error) {
      state.deps.log.warn(
        {
          storePath: state.deps.storePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "cron: failed to sanitize malformed persisted jobs after quarantine; continuing with quarantined in-memory view",
      );
    }
  }
}

/** Loads authoritative passive state without discarding enabled-scheduler transients. */
export async function ensureLoadedForOperation(state: CronServiceState): Promise<void> {
  await ensureLoaded(state, {
    forceReload: !state.deps.cronEnabled,
    deferQuarantinePersist: !state.deps.cronEnabled,
  });
  if (!state.deps.cronEnabled) {
    // A passive writer cannot sanitize the whole store without racing its scheduler owner.
    // Leave malformed rows for an enabled owner or doctor instead of carrying a full rewrite.
    state.pendingQuarantineConfigJobs = [];
    state.lastQuarantineFailureWarnKey = null;
  }
}

/** Emits the cron-disabled warning once per service state. */
export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

/** Persists quarantine and the surviving rows in one SQLite transaction. */
async function persistQuarantinedJobs(
  state: CronServiceState,
  store: CronStoreFile,
): Promise<boolean> {
  const quarantine = { entries: state.pendingQuarantineConfigJobs, nowMs: state.deps.nowMs() };
  try {
    const committed = await saveCronJobsStoreWithRevision(state.deps.storePath, store, {
      quarantine,
    });
    loadedCronStoreRevisions.set(state, committed);
  } catch (error) {
    if (
      error instanceof CronRunReceiptConflictError ||
      error instanceof CronRunReceiptRevisionError
    ) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const warnKey = `${state.deps.storePath}\0${errorMessage}`;
    if (state.lastQuarantineFailureWarnKey !== warnKey) {
      state.lastQuarantineFailureWarnKey = warnKey;
      state.deps.log.warn(
        { storePath: state.deps.storePath, error: errorMessage },
        "cron: failed to quarantine malformed persisted jobs; skipping active store sanitization",
      );
    }
    return false;
  }
  state.pendingQuarantineConfigJobs = [];
  state.lastQuarantineFailureWarnKey = null;
  publishDurableNextRunChanges({
    state,
    storeJobs: store.jobs,
  });
  return true;
}

/**
 * Notifications run after the durable commit; one throwing notify (e.g. an
 * auto-disable notice for a removed agent) must not drop its siblings or
 * masquerade as a store-write failure — at startup that keeps the whole
 * scheduler down.
 */
export async function runPostPersistCronNotifications(
  state: CronServiceState,
  notifications: DeferredCronNotifications | undefined,
) {
  for (const notification of notifications ?? []) {
    try {
      await dispatchCronNotification(state, notification);
    } catch (err) {
      state.deps.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "cron: post-persist notification failed",
      );
    }
  }
}

/** Captures the live cron state that must stay aligned with the durable store. */
export function snapshotStoreForRollback(state: CronServiceState): CronRollbackSnapshot {
  return {
    store: state.store ? structuredClone(state.store) : null,
    durableNextRunAtMsByJobId: new Map(state.durableNextRunAtMsByJobId),
  };
}

/** Retain the service and physical store before asynchronous mutation planning. */
export function captureCronServiceMutationSource(
  state: CronServiceState,
  context = captureOpenClawStateWorkerContext(),
) {
  const storeKey = cronStoreKey(state.deps.storePath);
  const generation = state.lifecycleGeneration;
  const assertStorageCurrent = () => {
    context.admission.assertCurrent();
    if (
      cronStoreKey(state.deps.storePath) !== storeKey ||
      resolveOpenClawStateSqlitePath() !== context.admission.databasePath
    ) {
      throw new Error("Cron mutation source or service changed before commit");
    }
  };
  return {
    context,
    storeKey,
    assertStorageCurrent,
    assertCurrent() {
      assertStorageCurrent();
      if (state.lifecycleGeneration !== generation) {
        throw new Error("Cron mutation source or service changed before commit");
      }
    },
  };
}

export function captureCronJobMutationSource(state: CronServiceState) {
  const source = captureCronServiceMutationSource(state);
  const resolveDefaultAgentId = () =>
    state.deps.resolveDefaultAgentId
      ? state.deps.resolveDefaultAgentId()
      : state.deps.defaultAgentId;
  const defaultAgentId = resolveDefaultAgentId();
  const effectiveDefaultAgentId = defaultAgentId ?? state.deps.defaultAgentId;
  return {
    ...source,
    defaultAgentId: effectiveDefaultAgentId,
    assertCurrent() {
      source.assertCurrent();
      const currentDefaultAgentId = resolveDefaultAgentId();
      if (
        currentDefaultAgentId !== defaultAgentId ||
        (currentDefaultAgentId ?? state.deps.defaultAgentId) !== effectiveDefaultAgentId
      ) {
        throw new Error("Cron mutation source or service changed before commit");
      }
    },
  };
}

/** Publish a private CRUD draft only after its job and receipt transaction is known committed. */
export async function persistCronJobMutation(params: {
  state: CronServiceState;
  source: ReturnType<typeof captureCronServiceMutationSource>;
  previous: CronStoreFile;
  next: CronStoreFile;
  method: "cron.add" | "cron.update" | "cron.remove";
  assertCurrent?: () => void;
  agentId?: string;
  preconditionJob?: CronJob;
  expectedJob?: { id: string; configRevision: string };
  receiptMutation?: CronRuntimeMutationInputs["cron.mutateJobs"]["receiptMutation"];
  afterCommit?: () => void;
  afterPublish?: () => void;
  suppressScheduledJobId?: string;
  postPersistNotifications?: DeferredCronNotifications;
}): Promise<void> {
  const { state, source } = params;
  assertCronStoreCanPersist(params.next);
  const changes = prepareCronStoreChanges(params.previous, params.next);
  const jobsFingerprint = loadedCronStoreRevisions.get(state)?.jobsFingerprint;
  const runtimeFingerprint = loadedCronStoreRevisions.get(state)?.runtimeFingerprint;
  if (
    state.deps.cronEnabled &&
    changes.changedIds.size > 0 &&
    (!jobsFingerprint || !runtimeFingerprint)
  ) {
    loadedCronStoreRevisions.set(state, { revision: -1 });
    throw new CronJobsStoreChangedError(source.storeKey);
  }
  const observedRevision = getCronJobsStoreRevision(source.storeKey);
  const markCommitted = captureCronMutationCommit(params.method);
  const quarantine =
    state.deps.cronEnabled &&
    changes.changedIds.size > 0 &&
    state.pendingQuarantineConfigJobs.length > 0
      ? { entries: state.pendingQuarantineConfigJobs, nowMs: state.deps.nowMs() }
      : undefined;
  let published = false;
  const assertCurrent = () => {
    source.assertCurrent();
    params.assertCurrent?.();
    source.assertCurrent();
    if (
      params.agentId !== undefined &&
      state.deps.isAgentAvailable?.(params.agentId, undefined, { deletionBlocked: false }) === false
    ) {
      throw new Error(describeUnavailableCronAgent(params.agentId));
    }
  };
  await runCronRuntimeMutation({
    context: source.context,
    type: "cron.mutateJobs",
    input: structuredClone({
      storeKey: source.storeKey,
      changes,
      agentId: params.agentId,
      preconditionJob: params.preconditionJob,
      expectedJob: params.expectedJob,
      receiptMutation: params.receiptMutation,
      replacement:
        state.deps.cronEnabled &&
        changes.changedIds.size > 0 &&
        jobsFingerprint &&
        runtimeFingerprint
          ? { store: params.next, jobsFingerprint, runtimeFingerprint, options: { quarantine } }
          : undefined,
    }),
    assertCurrent,
    // Config availability may change after dispatch; deletion is checked against worker rows.
    snapshot: { nowMs: state.deps.nowMs() },
    publish({
      store,
      names,
      jobsFingerprint: committedJobs,
      runtimeFingerprint: committedRuntime,
    }) {
      published = true;
      if (changes.changedIds.size > 0) {
        markCommitted?.();
      }
      const unchanged = getCronJobsStoreRevision(source.storeKey) === observedRevision;
      noteCronJobsStoreCommit(source.storeKey);
      if (unchanged) {
        publishCronJobNames(source.storeKey, source.context, names);
      }
      state.store = store;
      state.storeLoadedAtMs = state.deps.nowMs();
      if (quarantine) {
        state.pendingQuarantineConfigJobs = [];
        state.lastQuarantineFailureWarnKey = null;
      }
      loadedCronStoreRevisions.set(state, {
        revision: unchanged ? getCronJobsStoreRevision(source.storeKey) : -1,
        jobsFingerprint: committedJobs,
        runtimeFingerprint: committedRuntime,
      });
      try {
        params.afterCommit?.();
      } finally {
        try {
          publishDurableNextRunChanges({
            state,
            storeJobs: store.jobs,
            suppressScheduledJobId: params.suppressScheduledJobId,
          });
        } finally {
          params.afterPublish?.();
        }
      }
    },
    onSettled(outcome) {
      if (!published && outcome === "unknown") {
        noteCronJobsStoreCommit(source.storeKey);
        loadedCronStoreRevisions.set(state, { revision: -1 });
      }
    },
    onRolledBackMutation(refusal) {
      // A foreign receipt owner can advance runtime rows without publishing in this process.
      loadedCronStoreRevisions.set(state, { revision: -1 });
      throw refusal.kind === "receipt-conflict"
        ? new CronRunReceiptConflictError(refusal.receipt)
        : new CronJobsStoreChangedError(source.storeKey);
    },
  });
  await runPostPersistCronNotifications(state, params.postPersistNotifications);
}
