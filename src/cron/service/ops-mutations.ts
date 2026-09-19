import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../../agents/agent-lifecycle-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  type CronActiveJobMarker,
  noteActiveCronJobRemoval,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { withCronMutationCommitHook } from "../mutation-completion.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { removeCronJobBaseSession } from "../session-reaper.js";
import { removeStaleCronJobFamilyRows } from "../store.js";
import {
  isSystemMonitorDeclaration,
  systemOwnedDeclarationKeyNamespace,
} from "../system-owned-declaration.js";
import { normalizeCronTaskRunJobId } from "../task-run-history.js";
import {
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "../tools-allow-provenance.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import { declarativeFields } from "./jobs-declarative.js";
import { cloneCronJobForMutation, finalizeUpdatedJob } from "./jobs-mutation.js";
import {
  findJobOrThrow,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs-scheduling.js";
import {
  consumeRuntimeAuthorityMutationOptions,
  cronJobMessageActionAuthorityInputsEqual,
  cronJobMessageToolAuthorityInputsEqual,
  reconcileCronChannelRequesterAuthority,
  reconcileRuntimeAuthority,
} from "./jobs-tool-policy.js";
import {
  cronPatchTouchesDeliveryResolution,
  resolveConfiguredChannelsForValidation,
} from "./jobs-validation.js";
import { applyJobPatch, applyDeclarativeJobSpec, createJob } from "./jobs.js";
import {
  getPendingCronSessionCleanup,
  locked,
  registerPendingCronSessionCleanup,
} from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { resolveCurrentDefaultAgentId, resolveEffectiveJobAgentId } from "./ops-shared.js";
import { cronRunReceiptMutationHooks } from "./run-receipts.js";
import type {
  CronAddResult,
  CronAddOptions,
  CronServiceState,
  CronUpdateOptions,
  CronUpdatePrecondition,
  DeferredCronNotifications,
} from "./state.js";
import { emit } from "./state.js";
import {
  ensureLoaded,
  ensureLoadedForOperation,
  persist,
  persistOrRestore,
  persistNativeOrRestore,
  pruneCronJobScratchAfterCommit,
  runPostPersistCronNotifications,
  snapshotStoreForRollback,
  type CronRollbackSnapshot,
  warnIfDisabled,
} from "./store.js";
import { armTimer } from "./timer.js";

const RETRY_ADD_AFTER_SESSION_CLEANUP = new Error("retry add after session cleanup");

/** Cancels only caller-corroborated definitions while the durable lifecycle fence holds. */
export async function quiesceJobs(
  state: CronServiceState,
  jobs: readonly { id: string; revision: string }[],
  commitGuard: () => void,
): Promise<void> {
  await locked(state, async () => {
    await ensureLoadedForOperation(state);
    for (const expected of jobs) {
      const job = state.store?.jobs.find((candidate) => candidate.id === expected.id);
      if (!job || resolveCronJobConfigRevision(job) !== expected.revision) {
        throw new Error(`Cron job ${expected.id} changed before cancellation.`);
      }
    }
    commitGuard();
    for (const job of jobs) {
      requestActiveCronJobCancellation(job.id, "Claw agent removal.");
    }
  });
}

async function persistUpdatedJob(params: {
  state: CronServiceState;
  snapshot: CronRollbackSnapshot;
  previousJob: CronJob;
  nextJob: CronJob;
  persistStore: typeof persistOrRestore;
  mutationMethod: "cron.add" | "cron.update";
}) {
  const { state, snapshot, previousJob, nextJob, persistStore } = params;
  const reservation = state.queuedRunReservationsByJobId.get(nextJob.id);
  const preservesOnExitRearm =
    reservation?.onExit === true &&
    reservation.lifecycleGeneration === state.lifecycleGeneration &&
    reservation.markerAtMs === previousJob.state.queuedAtMs &&
    previousJob.schedule.kind === "on-exit" &&
    !previousJob.enabled &&
    nextJob.enabled &&
    resolveCronJobConfigRevision(previousJob) ===
      resolveCronJobConfigRevision({ ...nextJob, enabled: false });
  if (
    nextJob.state.queuedAtMs !== undefined &&
    !preservesOnExitRearm &&
    resolveCronJobConfigRevision(previousJob) !== resolveCronJobConfigRevision(nextJob)
  ) {
    // A consumed on-exit arm keeps its reservation when enabling its successor.
    // Other edits retire the queued occurrence; A→B→A cannot revive it.
    delete nextJob.state.queuedAtMs;
  }
  if (state.store) {
    const index = state.store.jobs.findIndex((entry) => entry.id === nextJob.id);
    if (index >= 0) {
      state.store.jobs[index] = nextJob;
    }
  }

  const defaultAgentId = resolveCurrentDefaultAgentId(state);
  const ownerChanged =
    resolveEffectiveJobAgentId(previousJob, defaultAgentId) !==
    resolveEffectiveJobAgentId(nextJob, defaultAgentId);
  const triggerStateChanged =
    !isDeepStrictEqual(previousJob.trigger, nextJob.trigger) ||
    !isDeepStrictEqual(previousJob.state.triggerState, nextJob.state.triggerState) ||
    ((previousJob.payload.kind === "script" || nextJob.payload.kind === "script") &&
      !isDeepStrictEqual(previousJob.payload, nextJob.payload));
  const scheduleChanged = !cronSchedulingInputsEqual(previousJob, nextJob);
  const messageActionAuthorityChanged =
    (isJobEnabled(previousJob) && !isJobEnabled(nextJob)) ||
    !cronJobMessageToolAuthorityInputsEqual(previousJob, nextJob);
  const messageSourceAuthorityChanged =
    !cronJobMessageActionAuthorityInputsEqual(previousJob, nextJob) ||
    (triggerStateChanged &&
      Boolean(
        resolveCronAuthenticatedChannelRequester(previousJob) ||
        resolveCronAuthenticatedChannelRequester(nextJob) ||
        resolveCronAuthenticatedCallerOrigin(previousJob) ||
        resolveCronAuthenticatedCallerOrigin(nextJob),
      ));
  await persistStore(state, snapshot, {
    suppressScheduledJobId: nextJob.id,
    transactionHooks: withCronMutationCommitHook(
      params.mutationMethod,
      cronRunReceiptMutationHooks({
        state,
        jobId: nextJob.id,
        ownerChanged,
        triggerStateChanged,
        messageActionAuthorityChanged,
        messageSourceAuthorityChanged,
        ...(scheduleChanged ? { scheduleChangedJob: nextJob } : {}),
      }),
    ),
  });
  if (isJobEnabled(previousJob) && !isJobEnabled(nextJob)) {
    requestActiveCronJobCancellation(nextJob.id, "Cron job disabled by operator.");
  }
  if (triggerStateChanged) {
    // Trigger/script definitions and shared-state edits retire the admitted
    // state writer; otherwise an obsolete evaluation or script wins later.
    noteActiveCronJobTriggerMutation(nextJob.id);
  }
  armTimer(state);
  emit(state, {
    jobId: nextJob.id,
    action: "updated",
    job: nextJob,
    nextRunAtMs: nextJob.state.nextRunAtMs,
  });
}

/** Adds or converges a declaration-keyed cron job inside one store lock and write transaction. */
export async function add(
  state: CronServiceState,
  input: CronJobCreate,
  opts?: CronAddOptions,
): Promise<CronAddResult> {
  let pendingSessionCleanup: Promise<void> | undefined;
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    if (input.payload.kind === "heartbeat" && opts?.systemOwned !== true) {
      throw new Error("system-owned payloads cannot be created by cron clients");
    }
    const declarationKey = normalizeOptionalString(input.declarationKey);
    const systemOwnedDeclarationNamespace = systemOwnedDeclarationKeyNamespace(declarationKey);
    if (systemOwnedDeclarationNamespace && opts?.systemOwned !== true) {
      throw new Error(
        `cron declarationKey namespace "${systemOwnedDeclarationNamespace}" is system-owned; jobs cannot be created with it`,
      );
    }
    await ensureLoadedForOperation(state);
    const agentId = resolveEffectiveJobAgentId(input, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(describeUnavailableCronAgent(agentId));
    }
    const normalizedId = normalizeOptionalString(input.id);
    if (input.id !== undefined && !normalizedId) {
      throw new Error("cron job id must not be blank");
    }
    if (normalizedId) {
      normalizeCronTaskRunJobId(normalizedId);
      pendingSessionCleanup = getPendingCronSessionCleanup(state, normalizedId);
      if (pendingSessionCleanup) {
        throw RETRY_ADD_AFTER_SESSION_CLEANUP;
      }
    }
    const normalizedInput = normalizedId ? { ...input, id: normalizedId } : input;
    const matches = declarationKey
      ? (state.store?.jobs.filter(
          (job) => job.declarationKey === declarationKey && (opts?.matchesExisting?.(job) ?? true),
        ) ?? [])
      : [];
    if (matches.length > 1) {
      throw new Error(`cron declarationKey is ambiguous within caller scope: ${declarationKey}`);
    }
    const existing = matches[0];
    const configuredChannels = await resolveConfiguredChannelsForValidation(state);
    const persistStore =
      opts?.commitGuard !== undefined || opts?.captureRuntimeAuthority !== undefined
        ? persistNativeOrRestore
        : persistOrRestore;

    if (existing) {
      const now = state.deps.nowMs();
      const nextJob = cloneCronJobForMutation(existing);
      applyDeclarativeJobSpec(nextJob, normalizedInput, {
        defaultAgentId: state.deps.defaultAgentId,
        enabledExplicit: opts?.enabledExplicit === true,
        nowMs: now,
        cronConfig: state.deps.cronConfig,
        scheduledToolPolicy: opts?.scheduledToolPolicy,
        toolsAllowProvenance: opts?.toolsAllowProvenance,
        toolsAllowExecTarget: opts?.toolsAllowExecTarget,
        configuredChannels,
      });
      finalizeUpdatedJob({
        job: existing,
        nextJob,
        now,
        schedulingInputsRequested: true,
        scheduleChanged: !isDeepStrictEqual(existing.schedule, nextJob.schedule),
        explicitTriggerState: normalizedInput.state,
      });
      const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
      reconcileRuntimeAuthority({
        job: nextJob,
        ...runtimeAuthorityMutation,
        explicitlyMutatesToolsAllow: normalizedInput.payload.toolsAllow !== undefined,
      });
      reconcileCronChannelRequesterAuthority({
        job: nextJob,
        previousJob: existing,
        toolsAllowProvenance: opts?.toolsAllowProvenance,
        reauthorize: true,
      });
      const includeEnabled = opts?.enabledExplicit === true;
      if (
        isDeepStrictEqual(
          declarativeFields(existing, includeEnabled),
          declarativeFields(nextJob, includeEnabled),
        )
      ) {
        return { ...existing, created: false, updated: false, job: existing };
      }
      const snapshot = snapshotStoreForRollback(state);
      await persistUpdatedJob({
        state,
        snapshot,
        previousJob: existing,
        nextJob,
        persistStore,
        mutationMethod: "cron.add",
      });
      return { ...nextJob, created: false, updated: true, job: nextJob };
    }

    if (normalizedId && state.store?.jobs.some((job) => job.id === normalizedId)) {
      throw new Error(`cron job already exists: ${normalizedId}`);
    }
    const explicitOwnerAgentId =
      normalizeOptionalAgentId(normalizedInput.agentId) ??
      parseAgentSessionKey(normalizeOptionalString(normalizedInput.sessionKey))?.agentId;
    const retainedLegacyAgentId = normalizeOptionalAgentId(state.deps.legacyDefaultAgentId);
    const creationInput =
      !explicitOwnerAgentId && retainedLegacyAgentId === agentId
        ? { ...normalizedInput, agentId }
        : normalizedInput;
    const snapshot = snapshotStoreForRollback(state);
    const job = createJob(state, creationInput, {
      scheduledToolPolicy: opts?.scheduledToolPolicy,
      toolsAllowProvenance: opts?.toolsAllowProvenance,
      toolsAllowExecTarget: opts?.toolsAllowExecTarget,
      configuredChannels,
    });
    if (opts?.createdActor) {
      job.createdActor = structuredClone(opts.createdActor);
    }
    if (opts?.skillLibrarySelections) {
      job.skillLibrarySelections = structuredClone(opts.skillLibrarySelections);
    }
    const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
    reconcileRuntimeAuthority({
      job,
      ...runtimeAuthorityMutation,
      explicitlyMutatesToolsAllow: normalizedInput.payload.toolsAllow !== undefined,
    });
    reconcileCronChannelRequesterAuthority({
      job,
      toolsAllowProvenance: opts?.toolsAllowProvenance,
    });
    state.store?.jobs.push(job);

    // Mutation notifications describe durable state, so publish them only
    // after the write succeeds instead of leaking a rolled-back transition.
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: postPersistNotifications,
    });

    await persistStore(state, snapshot, {
      postPersistNotifications,
      suppressScheduledJobId: job.id,
      transactionHooks: withCronMutationCommitHook("cron.add"),
    });
    armTimer(state);

    state.deps.log.info(
      {
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
        timerArmed: state.timer !== null,
        cronEnabled: state.deps.cronEnabled,
      },
      "cron: job added",
    );

    emit(state, {
      jobId: job.id,
      action: "added",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return declarationKey ? { ...job, created: true, job } : job;
  }).catch(async (error: unknown) => {
    if (error !== RETRY_ADD_AFTER_SESSION_CLEANUP || !pendingSessionCleanup) {
      throw error;
    }
    await pendingSessionCleanup;
    return await add(state, input, opts);
  });
}

/** Prunes an owned job family from obsolete store partitions after active-store convergence. */
export async function removeStaleJobFamily(
  state: CronServiceState,
  family: { declarationKey: string; name: string; ownerPluginTag: string },
  opts?: { commitGuard?: () => void },
): Promise<number> {
  return await locked(state, async () => {
    await ensureLoadedForOperation(state);
    opts?.commitGuard?.();
    return removeStaleCronJobFamilyRows(state.deps.storePath, family);
  });
}

async function updateLoadedJob(params: {
  state: CronServiceState;
  id: string;
  patch: CronJobPatch;
  precondition?: CronUpdatePrecondition;
  opts?: CronUpdateOptions;
}) {
  const { state, id, patch, precondition, opts } = params;
  warnIfDisabled(state, "update");
  if (patch.payload?.kind === "heartbeat") {
    throw new Error("system-owned payloads cannot be patched by cron clients");
  }
  await ensureLoadedForOperation(state);
  const job = findJobOrThrow(state, id);
  // Existing monitors are config-driven: any patch (disable, reschedule,
  // repurpose) would silently diverge from its owner until the next reconcile,
  // so updates are rejected outright. Removal stays allowed only to the owner.
  if (isSystemMonitorDeclaration(job.declarationKey)) {
    throw new Error("system-owned monitor jobs cannot be edited by cron clients");
  }
  const now = state.deps.nowMs();
  const configuredChannels = cronPatchTouchesDeliveryResolution(patch)
    ? await resolveConfiguredChannelsForValidation(state)
    : undefined;
  await precondition?.(structuredClone(job), now);
  const nextJob = cloneCronJobForMutation(job);
  applyJobPatch(nextJob, patch, {
    defaultAgentId: resolveCurrentDefaultAgentId(state),
    scheduleValidationNowMs: now,
    cronConfig: state.deps.cronConfig,
    scheduledToolPolicy: opts?.scheduledToolPolicy,
    toolsAllowProvenance: opts?.toolsAllowProvenance,
    toolsAllowExecTarget: opts?.toolsAllowExecTarget,
    configuredChannels,
  });
  if (patch.agentId !== undefined) {
    const agentId = resolveEffectiveJobAgentId(nextJob, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(describeUnavailableCronAgent(agentId));
    }
  }
  finalizeUpdatedJob({
    job,
    nextJob,
    now,
    schedulingInputsRequested:
      patch.schedule !== undefined ||
      patch.enabled !== undefined ||
      "trigger" in patch ||
      "pacing" in patch,
    scheduleChanged: patch.schedule !== undefined,
    explicitTriggerState: patch.state,
  });
  const persistStore =
    precondition !== undefined ||
    opts?.commitGuard !== undefined ||
    opts?.captureRuntimeAuthority !== undefined
      ? persistNativeOrRestore
      : persistOrRestore;
  const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
  reconcileRuntimeAuthority({
    job: nextJob,
    ...runtimeAuthorityMutation,
    explicitlyMutatesToolsAllow:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
  });
  reconcileCronChannelRequesterAuthority({
    job: nextJob,
    previousJob: job,
    toolsAllowProvenance: opts?.toolsAllowProvenance,
    reauthorize: patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
    reauthorizeCallerOrigin:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
  });
  const snapshot = snapshotStoreForRollback(state);
  await persistUpdatedJob({
    state,
    snapshot,
    previousJob: job,
    nextJob,
    persistStore,
    mutationMethod: "cron.update",
  });
  return nextJob;
}

/** Updates a cron job patch in-place, recomputes affected schedule state, and persists it. */
export async function update(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  opts?: CronUpdateOptions,
) {
  return await locked(state, async () => await updateLoadedJob({ state, id, patch, opts }));
}

/** Updates a cron job only after a store-locked caller precondition passes. */
export async function updateWithPrecondition(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  precondition: CronUpdatePrecondition,
  opts?: CronUpdateOptions,
) {
  return await locked(
    state,
    async () => await updateLoadedJob({ state, id, patch, precondition, opts }),
  );
}

/** Removes a cron job by id and re-arms the timer when the in-memory store changes. */
export async function remove(
  state: CronServiceState,
  id: string,
  opts?: { systemOwned?: boolean; commitGuard?: () => void },
) {
  let sessionCleanup:
    | {
        activeMarker: CronActiveJobMarker | undefined;
        agentId: string;
        sessionStorePath: string;
        done: Promise<void>;
        finish: () => void;
        release: () => void;
      }
    | undefined;
  const result = await locked(state, async () => {
    warnIfDisabled(state, "remove");
    const previousStore = state.store;
    await ensureLoadedForOperation(state);
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    const removedJob = state.store.jobs.find((j) => j.id === id);
    if (!removedJob) {
      if (state.store !== previousStore) {
        armTimer(state);
      }
      return { ok: true, removed: false } as const;
    }
    // Config is the monitor's source of truth: ad-hoc deletion would disable
    // the feature until an unrelated reload, so only gateway reconciliation
    // (stale-monitor cleanup) may remove one.
    if (isSystemMonitorDeclaration(removedJob.declarationKey) && opts?.systemOwned !== true) {
      throw new Error("system-owned monitor jobs cannot be removed by cron clients");
    }
    const persistStore = opts?.commitGuard ? persistNativeOrRestore : persistOrRestore;
    opts?.commitGuard?.();
    const snapshot = snapshotStoreForRollback(state);
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);

    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: postPersistNotifications,
    });

    await persistStore(state, snapshot, {
      postPersistNotifications,
      suppressScheduledJobId: id,
      transactionHooks: withCronMutationCommitHook("cron.remove"),
    });
    const activeMarker = noteActiveCronJobRemoval(id, opts?.commitGuard);
    const agentId = resolveEffectiveJobAgentId(removedJob, resolveCurrentDefaultAgentId(state));
    const sessionStorePath =
      state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
    if (
      sessionStorePath &&
      (removedJob.sessionTarget === "isolated" || removedJob.sessionTarget === "current")
    ) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const release = registerPendingCronSessionCleanup(state, id, done, agentId);
      sessionCleanup = {
        activeMarker,
        agentId,
        sessionStorePath,
        done,
        finish,
        release,
      };
    }
    pruneCronJobScratchAfterCommit(state, [id]);
    armTimer(state);
    emit(state, { jobId: id, action: "removed", job: removedJob });
    return { ok: true, removed: true } as const;
  });
  if (!sessionCleanup) {
    return result;
  }
  const { activeMarker, agentId, sessionStorePath, finish, release } = sessionCleanup;
  const cleanup = async () => {
    try {
      const shouldRemove = await locked(state, async () => {
        await ensureLoaded(state, { skipRecompute: true });
        return !state.store?.jobs.some((job) => job.id === id);
      });
      if (shouldRemove) {
        await removeCronJobBaseSession({
          agentId,
          jobId: id,
          sessionStorePath,
        });
      }
      return undefined;
    } catch (error) {
      const message = `Cron job ${id} was removed, but session cleanup failed: ${String(error)}. Use openclaw sessions list --json, then openclaw sessions delete to retry.`;
      state.deps.log.warn({ jobId: id, err: message }, "cron: session cleanup failed");
      return message;
    } finally {
      release();
      finish();
    }
  };
  if (activeMarker) {
    onCronJobInactive(activeMarker, () => void cleanup());
    return { ...result, sessionCleanup: "pending" as const };
  }
  const cleanupError = await cleanup();
  if (cleanupError) {
    throw new Error(cleanupError);
  }
  return result;
}

/** Remove one agent's jobs while holding the cron lock across an external roster commit. */
export async function removeAgentJobsTransactional<T>(
  state: CronServiceState,
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove agent jobs");
    await ensureLoadedForOperation(state);
    const id = normalizeOptionalAgentId(agentId);
    if (!id || !state.store) {
      return await commit();
    }
    const defaultAgentId = resolveCurrentDefaultAgentId(state);
    const removedJobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) === id,
    );
    if (removedJobs.length === 0) {
      return await commit();
    }
    const snapshot = snapshotStoreForRollback(state);
    state.store.jobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) !== id,
    );
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, { deferredNotifications: postPersistNotifications });
    // Cron is durable first, but notifications stay speculative until the roster commits.
    await persistOrRestore(state, snapshot);
    let result: T;
    try {
      result = await commit();
    } catch (error) {
      if (error instanceof AgentDeletionCommitUncertainError) {
        // Uncertain roster writes intentionally keep the cron deletion durable.
        runPostPersistCronNotifications(state, postPersistNotifications);
        armTimer(state);
        for (const job of removedJobs) {
          noteActiveCronJobRemoval(job.id);
        }
        pruneCronJobScratchAfterCommit(
          state,
          removedJobs.map((job) => job.id),
        );
        for (const job of removedJobs) {
          emit(state, { jobId: job.id, action: "removed", job });
        }
        throw error;
      }
      try {
        if (state.deps.cronEnabled) {
          state.store = snapshot.store;
          state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
          if (!(await persist(state))) {
            throw new Error("cron: rollback store write did not complete", { cause: error });
          }
        } else {
          const deletedSnapshot = snapshotStoreForRollback(state);
          state.store = snapshot.store;
          state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
          await persistOrRestore(state, deletedSnapshot, { preserveConcurrentAdds: true });
        }
        armTimer(state);
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `cron: failed to roll back agent job deletion for ${id}`,
          { cause: error },
        );
      }
      throw error;
    }
    runPostPersistCronNotifications(state, postPersistNotifications);
    for (const job of removedJobs) {
      noteActiveCronJobRemoval(job.id);
    }
    pruneCronJobScratchAfterCommit(
      state,
      removedJobs.map((job) => job.id),
    );
    armTimer(state);
    for (const job of removedJobs) {
      emit(state, { jobId: job.id, action: "removed", job });
    }
    return result;
  });
}
