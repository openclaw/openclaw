/** Loads, normalizes, quarantines, and persists cron service store state. */
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { isInvalidCronSessionTargetIdError } from "../session-target.js";
import {
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  CronStoreTopologyMismatchError,
  loadCronJobsStoreWithConfigJobs,
  saveCronQuarantineFile,
  saveCronJobsStore,
  type QuarantinedCronConfigJob,
} from "../store.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import { prepareReloadedCronJobsForScheduling } from "./reload-scheduling.js";
import { emit, type CronServiceState } from "./state.js";

type PersistOptions = {
  stateOnly?: boolean;
  suppressScheduledJobId?: string;
};

export type CronRollbackSnapshot = {
  store: CronStoreFile | null;
  storeEpoch: number;
  durableTopologyFingerprintByJobId: Map<string, string>;
  durableSchedulingJobsById: Map<string, CronJob>;
  runtimeRevision: number;
  durableNextRunAtMsByJobId: Map<string, number | undefined>;
  durableRuntimeStateByJobId: Map<string, CronJob["state"]>;
  durableRuntimeUpdatedAtMsByJobId: Map<string, number>;
};

function snapshotRuntimeStateByJobId(jobs: CronJob[]): Map<string, CronJob["state"]> {
  return new Map(jobs.map((job) => [job.id, structuredClone(job.state ?? {})]));
}

function snapshotRuntimeUpdatedAtMsByJobId(jobs: CronJob[]): Map<string, number> {
  return new Map(jobs.map((job) => [job.id, job.updatedAtMs]));
}

function snapshotSchedulingJobsById(jobs: readonly CronJob[]): Map<string, CronJob> {
  return new Map(jobs.map((job) => [job.id, structuredClone(job)]));
}

function durableNextRunsFromJobs(jobs: readonly CronJob[]) {
  return new Map(jobs.map((job) => [job.id, job.state.nextRunAtMs] as const));
}

function mergeCommittedCronStoreIntoLive(
  liveStore: CronStoreFile,
  committedStore: CronStoreFile,
): CronStoreFile {
  const liveJobsById = new Map(liveStore.jobs.map((job) => [job.id, job]));
  const mergedJobs = committedStore.jobs.map((committedJob) => {
    const liveJob = liveJobsById.get(committedJob.id);
    if (!liveJob) {
      return committedJob;
    }
    const liveRecord = liveJob as unknown as Record<string, unknown>;
    const committedRecord = committedJob as unknown as Record<string, unknown>;
    for (const key of Object.keys(liveRecord)) {
      if (!Object.hasOwn(committedRecord, key)) {
        delete liveRecord[key];
      }
    }
    Object.assign(liveRecord, committedRecord);
    return liveJob;
  });
  // Timer and mutation callers retain job references across persist(). Preserve
  // same-id objects and the store array while publishing the merged durable state.
  liveStore.version = committedStore.version;
  liveStore.jobs.splice(0, liveStore.jobs.length, ...mergedJobs);
  return liveStore;
}

function publishDurableNextRunChanges(params: {
  state: CronServiceState;
  storeJobs: readonly CronJob[];
  stateOnly: boolean;
  suppressScheduledJobId?: string;
}) {
  const previous = params.state.durableNextRunAtMsByJobId;
  const next = params.stateOnly ? new Map(previous) : durableNextRunsFromJobs(params.storeJobs);

  if (params.stateOnly) {
    const currentJobsById = new Map(params.storeJobs.map((job) => [job.id, job] as const));
    // State-only writes cannot create or delete rows. Preserve durable topology
    // and update only rows that both snapshots know SQLite already contains.
    for (const jobId of previous.keys()) {
      const job = currentJobsById.get(jobId);
      if (job) {
        next.set(jobId, job.state.nextRunAtMs);
      }
    }
  }

  const changedJobs = params.storeJobs.filter((job) => {
    if (!previous.has(job.id) || !next.has(job.id)) {
      return false;
    }
    return previous.get(job.id) !== next.get(job.id);
  });

  // Advance durable truth before callbacks so re-entrant observers cannot
  // publish the same committed transition twice.
  params.state.durableNextRunAtMsByJobId = next;
  for (const job of changedJobs) {
    if (job.id === params.suppressScheduledJobId) {
      continue;
    }
    emit(params.state, {
      jobId: job.id,
      action: "scheduled",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
}

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
  params.hydrated.state.forcePreservedNextRunAtMs = undefined;
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

async function flushPendingQuarantine(
  state: CronServiceState,
  nowMs: number,
): Promise<string | null> {
  if (state.pendingQuarantineConfigJobs.length === 0) {
    return null;
  }
  try {
    const quarantinePath = await saveCronQuarantineFile({
      storePath: state.deps.storePath,
      entries: state.pendingQuarantineConfigJobs,
      nowMs,
    });
    state.pendingQuarantineConfigJobs = [];
    state.lastQuarantineFailureWarnKey = null;
    return quarantinePath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const warnKey = `${state.deps.storePath}\0${errorMessage}`;
    if (state.lastQuarantineFailureWarnKey !== warnKey) {
      state.lastQuarantineFailureWarnKey = warnKey;
      state.deps.log.warn(
        {
          storePath: state.deps.storePath,
          error: errorMessage,
        },
        "cron: failed to quarantine malformed persisted jobs; skipping active store sanitization",
      );
    }
    return null;
  }
}

/** Loads and normalizes the cron store, quarantining invalid persisted rows before runtime use. */
export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
    /** Override live jobs with the last durable scheduling baseline during conflict recovery. */
    previousSchedulingJobsById?: ReadonlyMap<string, CronJob>;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  const previousJobsById = new Map<string, CronJob>(
    opts?.previousSchedulingJobsById ??
      (state.store?.jobs ?? []).map((job) => [job.id, job] as const),
  );
  const loaded = await loadCronJobsStoreWithConfigJobs(state.deps.storePath, state.deps.env);
  // Persisted cron rows are validated lazily, so treat them as raw records at the
  // store boundary and only trust the CronJob shape after validation below.
  const loadedJobs = (loaded.store.jobs ?? []) as unknown as Record<string, unknown>[];
  const jobs: CronJob[] = [];
  const legacyImportedJobIds = new Set<string>();
  const durableNextRunAtMsByJobId = new Map<string, number | undefined>();
  const durableRuntimeStateByJobId = new Map<string, CronJob["state"]>();
  const durableRuntimeUpdatedAtMsByJobId = new Map<string, number>();
  const durableSchedulingJobsById = new Map<string, CronJob>();
  const quarantinedConfigJobs: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  for (const [index, raw] of loadedJobs.entries()) {
    const rawConfigJob = loaded.configJobs[index] ?? structuredClone(raw);
    const sourceIndex = loaded.configJobIndexes[index] ?? index;
    const runtimeEntry = loaded.configJobRuntimeEntries[index];
    // Accept old `jobId` rows at the raw boundary only; the in-memory store
    // uses canonical `id` before validation and scheduling.
    normalizeCronJobIdentityFields(raw);
    let normalized: Record<string, unknown> | null;
    try {
      normalized = normalizeCronJobInput(raw);
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
    const invalidReason = getInvalidPersistedCronJobReason(hydratedRaw);
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
    const hydrated = hydratedRaw as unknown as CronJob;
    jobs.push(hydrated);
    if (loaded.legacyImportedJobIndexes.includes(index)) {
      legacyImportedJobIds.add(hydrated.id);
    }
    // Capture the value SQLite actually held before schedule-identity repair
    // mutates the runtime view. A later save can then publish that transition.
    durableNextRunAtMsByJobId.set(hydrated.id, hydrated.state.nextRunAtMs);
    durableRuntimeStateByJobId.set(hydrated.id, structuredClone(hydrated.state ?? {}));
    durableRuntimeUpdatedAtMsByJobId.set(hydrated.id, hydrated.updatedAtMs);
    durableSchedulingJobsById.set(hydrated.id, structuredClone(hydrated));
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.storeEpoch = loaded.storeEpoch;
  state.durableTopologyFingerprintByJobId = new Map(loaded.topologyFingerprintByJobId);
  state.durableSchedulingJobsById = durableSchedulingJobsById;
  state.runtimeRevision = loaded.runtimeRevision;
  state.legacyImportedJobIds = legacyImportedJobIds;
  state.durableNextRunAtMsByJobId = durableNextRunAtMsByJobId;
  state.durableRuntimeStateByJobId = durableRuntimeStateByJobId;
  state.durableRuntimeUpdatedAtMsByJobId = durableRuntimeUpdatedAtMsByJobId;
  state.storeLoadedAtMs = state.deps.nowMs();

  if (quarantinedConfigJobs.length > 0) {
    state.pendingQuarantineConfigJobs = quarantinedConfigJobs;
    const quarantinePath = await flushPendingQuarantine(state, state.storeLoadedAtMs);
    if (quarantinePath) {
      try {
        await persist(state);
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            quarantinePath,
            quarantinedJobs: quarantinedConfigJobs.length,
          },
          "cron: sanitized active cron store after quarantining malformed persisted jobs",
        );
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

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
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

/** Persists the in-memory cron store, flushing pending quarantine records first. */
export async function persist(state: CronServiceState, opts?: PersistOptions) {
  const store = state.store;
  if (!store) {
    return false;
  }
  let flushedPendingQuarantine = false;
  if (state.pendingQuarantineConfigJobs.length > 0) {
    const quarantinePath = await flushPendingQuarantine(state, state.deps.nowMs());
    if (!quarantinePath) {
      return false;
    }
    flushedPendingQuarantine = true;
  }
  const stateOnly = !flushedPendingQuarantine && opts?.stateOnly === true;
  let persistedStore = store;
  try {
    const committed = await saveCronJobsStore(
      state.deps.storePath,
      store,
      stateOnly
        ? {
            stateOnly: true,
            expectedStoreEpoch: state.storeEpoch,
            expectedRuntimeRevision: state.runtimeRevision,
            expectedRuntimeStateByJobId: state.durableRuntimeStateByJobId,
            expectedRuntimeUpdatedAtMsByJobId: state.durableRuntimeUpdatedAtMsByJobId,
            env: state.deps.env,
          }
        : {
            expectedStoreEpoch: state.storeEpoch,
            expectedTopologyFingerprintByJobId: state.durableTopologyFingerprintByJobId,
            expectedRuntimeRevision: state.runtimeRevision,
            expectedRuntimeStateByJobId: state.durableRuntimeStateByJobId,
            expectedRuntimeUpdatedAtMsByJobId: state.durableRuntimeUpdatedAtMsByJobId,
            env: state.deps.env,
          },
    );
    if (committed) {
      state.storeEpoch = committed.storeEpoch;
      state.runtimeRevision = committed.runtimeRevision;
      state.durableTopologyFingerprintByJobId = new Map(committed.topologyFingerprintByJobId);
      state.durableSchedulingJobsById = snapshotSchedulingJobsById(committed.store.jobs);
      // The canonical store can differ even without a revision bump when a pre-upgrade
      // writer changes rows. Always publish it so stale topology cannot be resurrected.
      persistedStore = mergeCommittedCronStoreIntoLive(store, committed.store);
      state.store = persistedStore;
      state.durableRuntimeStateByJobId = snapshotRuntimeStateByJobId(committed.store.jobs);
      state.durableRuntimeUpdatedAtMsByJobId = snapshotRuntimeUpdatedAtMsByJobId(
        committed.store.jobs,
      );
    }
  } catch (error) {
    if (
      error instanceof CronStoreEpochMismatchError ||
      error instanceof CronStoreTopologyMismatchError ||
      error instanceof CronRuntimeRevisionMismatchError
    ) {
      // Another process changed ownership/topology. Refuse this stale snapshot
      // and publish the durable replacement to the scheduler before returning.
      try {
        await ensureLoaded(state, {
          forceReload: true,
          skipRecompute: true,
          previousSchedulingJobsById: state.durableSchedulingJobsById,
        });
        const scheduledReloadedJobs = prepareReloadedCronJobsForScheduling(state);
        if (scheduledReloadedJobs && state.store) {
          const repaired = await saveCronJobsStore(state.deps.storePath, state.store, {
            stateOnly: true,
            expectedStoreEpoch: state.storeEpoch,
            expectedRuntimeRevision: state.runtimeRevision,
            expectedRuntimeStateByJobId: state.durableRuntimeStateByJobId,
            expectedRuntimeUpdatedAtMsByJobId: state.durableRuntimeUpdatedAtMsByJobId,
            env: state.deps.env,
          });
          if (repaired) {
            state.storeEpoch = repaired.storeEpoch;
            state.runtimeRevision = repaired.runtimeRevision;
            state.durableTopologyFingerprintByJobId = new Map(repaired.topologyFingerprintByJobId);
            state.durableSchedulingJobsById = snapshotSchedulingJobsById(repaired.store.jobs);
            const repairedStore = mergeCommittedCronStoreIntoLive(state.store, repaired.store);
            state.store = repairedStore;
            state.durableRuntimeStateByJobId = snapshotRuntimeStateByJobId(repaired.store.jobs);
            state.durableRuntimeUpdatedAtMsByJobId = snapshotRuntimeUpdatedAtMsByJobId(
              repaired.store.jobs,
            );
            publishDurableNextRunChanges({
              state,
              storeJobs: repairedStore.jobs,
              stateOnly: true,
            });
          }
        }
        // Keep this rare recovery edge lazy: timer-scheduler imports this store,
        // so an eager import here would create a module-initialization cycle.
        const { armTimerAfterStoreReload } = await import("./timer-arm.runtime.js");
        armTimerAfterStoreReload(state);
      } catch (reloadError) {
        // Preserve the mismatch classification so persistOrRestore cannot put
        // the stale snapshot back. The next operation must load from SQLite.
        state.store = null;
        if (error instanceof CronStoreEpochMismatchError) {
          state.storeEpoch = error.actualEpoch;
        } else if (error instanceof CronRuntimeRevisionMismatchError) {
          state.runtimeRevision = error.actualRevision;
        }
        state.durableNextRunAtMsByJobId = new Map();
        state.durableTopologyFingerprintByJobId = new Map();
        state.durableSchedulingJobsById = new Map();
        state.durableRuntimeStateByJobId = new Map();
        state.durableRuntimeUpdatedAtMsByJobId = new Map();
        state.deps.log.warn(
          {
            storePath: state.deps.storePath,
            error: reloadError instanceof Error ? reloadError.message : String(reloadError),
          },
          "cron: stale store write refused, but reloading the newer epoch failed",
        );
      }
    }
    throw error;
  }
  publishDurableNextRunChanges({
    state,
    storeJobs: persistedStore.jobs,
    stateOnly,
    suppressScheduledJobId: opts?.suppressScheduledJobId,
  });
  return true;
}

/** Captures the live cron state that must stay aligned with the durable store. */
export function snapshotStoreForRollback(state: CronServiceState): CronRollbackSnapshot {
  return {
    store: state.store ? structuredClone(state.store) : null,
    storeEpoch: state.storeEpoch,
    durableTopologyFingerprintByJobId: new Map(state.durableTopologyFingerprintByJobId),
    durableSchedulingJobsById: snapshotSchedulingJobsById([
      ...state.durableSchedulingJobsById.values(),
    ]),
    runtimeRevision: state.runtimeRevision,
    durableNextRunAtMsByJobId: new Map(state.durableNextRunAtMsByJobId),
    durableRuntimeStateByJobId: new Map(
      [...state.durableRuntimeStateByJobId].map(([jobId, runtimeState]) => [
        jobId,
        structuredClone(runtimeState),
      ]),
    ),
    durableRuntimeUpdatedAtMsByJobId: new Map(state.durableRuntimeUpdatedAtMsByJobId),
  };
}

// A failed durable write must not leave readers observing speculative job
// topology, wake times, or catch-up ownership after the store lock releases.
export async function persistOrRestore(
  state: CronServiceState,
  snapshot: CronRollbackSnapshot,
  opts: {
    postPersistAutoDisableNotifications?: Array<() => void>;
    suppressScheduledJobId?: string;
  } = {},
) {
  try {
    const persisted = await persist(
      state,
      opts.suppressScheduledJobId === undefined
        ? undefined
        : { suppressScheduledJobId: opts.suppressScheduledJobId },
    );
    if (!persisted) {
      throw new Error("cron: durable store write did not complete");
    }
  } catch (err) {
    if (
      !(err instanceof CronStoreEpochMismatchError) &&
      !(err instanceof CronStoreTopologyMismatchError) &&
      !(err instanceof CronRuntimeRevisionMismatchError)
    ) {
      state.store = snapshot.store;
      state.storeEpoch = snapshot.storeEpoch;
      state.durableTopologyFingerprintByJobId = snapshot.durableTopologyFingerprintByJobId;
      state.durableSchedulingJobsById = snapshot.durableSchedulingJobsById;
      state.runtimeRevision = snapshot.runtimeRevision;
      state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
      state.durableRuntimeStateByJobId = snapshot.durableRuntimeStateByJobId;
      state.durableRuntimeUpdatedAtMsByJobId = snapshot.durableRuntimeUpdatedAtMsByJobId;
    }
    throw err;
  }
  for (const notify of opts.postPersistAutoDisableNotifications ?? []) {
    notify();
  }
}
