import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { AgentDeletionCommitUncertainError } from "../../agents/agent-lifecycle-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  type CronActiveJobMarker,
  noteActiveCronJobRemoval,
  onCronJobInactive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId, tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { normalizeCronRunJobId } from "../run-history.js";
import { removeCronJobBaseSession } from "../session-reaper.js";
import { removeStaleCronJobFamilyRows } from "../store.js";
import {
  isSystemMonitorDeclaration,
  systemOwnedDeclarationKeyNamespace,
} from "../system-owned-declaration.js";
import type { CronJobCreate, CronJobPatch } from "../types.js";
import { declarativeFields } from "./jobs-declarative.js";
import { persistUpdatedJob } from "./jobs-mutation-persistence.js";
import { cloneCronJobForMutation, finalizeUpdatedJob } from "./jobs-mutation.js";
import {
  findJobOrThrow,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs-scheduling.js";
import {
  consumeRuntimeAuthorityMutationOptions,
  reconcileCronChannelRequesterAuthority,
  reconcileRuntimeAuthority,
} from "./jobs-tool-policy.js";
import {
  cronPatchTouchesDeliveryResolution,
  resolveConfiguredChannelsForValidation,
} from "./jobs-validation.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "./jobs.js";
import {
  getPendingCronSessionCleanup,
  locked,
  registerPendingCronSessionCleanup,
} from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { resolveCurrentDefaultAgentId } from "./ops-shared.js";
import { prepareCronRunReceiptOwnerMutation } from "./run-receipts.js";
import type {
  CronAddOptions,
  CronAddResult,
  CronServiceState,
  CronUpdateOptions,
  CronUpdatePrecondition,
  DeferredCronNotifications,
} from "./state.js";
import { emit } from "./state.js";
import {
  captureCronJobMutationSource,
  captureCronServiceMutationSource,
  ensureLoaded,
  ensureLoadedForOperation,
  persistCronJobMutation,
  snapshotStoreForRollback,
  warnIfDisabled,
} from "./store.js";
import { armTimer } from "./timer.js";

const RETRY_ADD_AFTER_SESSION_CLEANUP = new Error("retry add after session cleanup");

/** Cancels only caller-corroborated definitions while the durable lifecycle fence holds. */
export async function quiesceJobs(
  state: CronServiceState,
  jobs: readonly { id: string; revision: string }[],
  commitGuard: (cancel: () => void) => void | Promise<void>,
): Promise<void> {
  await locked(state, async () => {
    await ensureLoadedForOperation(state);
    for (const expected of jobs) {
      const job = state.store?.jobs.find((candidate) => candidate.id === expected.id);
      if (!job || resolveCronJobConfigRevision(job) !== expected.revision) {
        throw new Error(`Cron job ${expected.id} changed before cancellation.`);
      }
    }
    let cancelled = false;
    const cancel = () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      for (const job of jobs) {
        requestActiveCronJobCancellation(job.id, "Claw agent removal.");
      }
    };
    await commitGuard(cancel);
    cancel();
  });
}

/** Adds or converges a declaration-keyed cron job inside one store lock and write transaction. */
export async function add(
  state: CronServiceState,
  input: CronJobCreate,
  opts?: CronAddOptions,
): Promise<CronAddResult> {
  const source = captureCronJobMutationSource(state);
  let pendingSessionCleanup: Promise<void> | undefined;
  return await locked(state, async () => {
    source.assertCurrent();
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
    const agentId = resolveCronJobEffectiveAgentId(input, resolveCurrentDefaultAgentId(state));
    const normalizedId = normalizeOptionalString(input.id);
    if (input.id !== undefined && !normalizedId) {
      throw new Error("cron job id must not be blank");
    }
    if (normalizedId) {
      normalizeCronRunJobId(normalizedId);
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
    source.assertCurrent();

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
        if (!state.store) {
          throw new Error("Cron declaration has no loaded store");
        }
        await persistCronJobMutation({
          state,
          source,
          previous: state.store,
          next: state.store,
          method: "cron.add",
          assertCurrent: opts?.commitGuard,
          agentId,
          expectedJob: { id: existing.id, configRevision: resolveCronJobConfigRevision(existing) },
        });
        const committedJob = findJobOrThrow(state, existing.id);
        return { ...committedJob, created: false, updated: false, job: committedJob };
      }
      const snapshot = snapshotStoreForRollback(state);
      const committedJob = await persistUpdatedJob({
        state,
        snapshot,
        previousJob: existing,
        nextJob,
        source,
        commitGuard: opts?.commitGuard,
        agentId,
        mutationMethod: "cron.add",
      });
      return { ...committedJob, created: false, updated: true, job: committedJob };
    }

    if (normalizedId && state.store?.jobs.some((job) => job.id === normalizedId)) {
      throw new Error(`cron job already exists: ${normalizedId}`);
    }
    const explicitOwnerAgentId =
      normalizeOptionalAgentId(normalizedInput.agentId) ??
      parseAgentSessionKey(normalizeOptionalString(normalizedInput.sessionKey))?.agentId;
    const retainedLegacyAgentId = normalizeOptionalAgentId(state.deps.legacyDefaultAgentId);
    const creationInput =
      !explicitOwnerAgentId && retainedLegacyAgentId
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
    if (!snapshot.store) {
      throw new Error("Cron add has no loaded store");
    }
    const nextStore = { ...snapshot.store, jobs: [...structuredClone(snapshot.store.jobs), job] };

    // Mutation notifications describe durable state, so publish them only
    // after the write succeeds instead of leaking a rolled-back transition.
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(
      { ...state, store: nextStore },
      {
        deferredNotifications: postPersistNotifications,
      },
    );

    await persistCronJobMutation({
      state,
      source,
      previous: snapshot.store,
      next: nextStore,
      method: "cron.add",
      assertCurrent: opts?.commitGuard,
      agentId,
      postPersistNotifications,
      suppressScheduledJobId: job.id,
      afterPublish: () => {
        armTimer(state);
        const committedJob = findJobOrThrow(state, job.id);

        state.deps.log.info(
          {
            jobId: committedJob.id,
            jobName: committedJob.name,
            nextRunAtMs: committedJob.state.nextRunAtMs,
            schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
            timerArmed: state.timer !== null,
            cronEnabled: state.deps.cronEnabled,
          },
          "cron: job added",
        );

        emit(state, {
          jobId: job.id,
          action: "added",
          job: committedJob,
          nextRunAtMs: committedJob.state.nextRunAtMs,
        });
      },
    });
    const committedJob = findJobOrThrow(state, job.id);
    return declarationKey ? { ...committedJob, created: true, job: committedJob } : committedJob;
  }).catch(async (error: unknown) => {
    if (error !== RETRY_ADD_AFTER_SESSION_CLEANUP || !pendingSessionCleanup) {
      throw error;
    }
    await pendingSessionCleanup;
    source.assertCurrent();
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
    return await removeStaleCronJobFamilyRows(state.deps.storePath, family, opts);
  });
}

async function updateLoadedJob(params: {
  state: CronServiceState;
  source: ReturnType<typeof captureCronJobMutationSource>;
  id: string;
  patch: CronJobPatch;
  precondition?: CronUpdatePrecondition;
  opts?: CronUpdateOptions;
}) {
  const { state, source, id, patch, precondition, opts } = params;
  source.assertCurrent();
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
  const ownerPreparation = prepareCronRunReceiptOwnerMutation({
    state,
    previousJob: job,
    nextJob,
  });
  const ownerMutation = ownerPreparation ? await ownerPreparation : undefined;
  source.assertCurrent();
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
  return await persistUpdatedJob({
    state,
    snapshot,
    previousJob: job,
    nextJob,
    source,
    commitGuard: opts?.commitGuard,
    agentId:
      patch.agentId !== undefined
        ? resolveCronJobEffectiveAgentId(nextJob, resolveCurrentDefaultAgentId(state))
        : undefined,
    preconditionJob: precondition ? job : undefined,
    mutationMethod: "cron.update",
    ownerMutation,
  });
}

/** Updates a cron job patch in-place, recomputes affected schedule state, and persists it. */
export async function update(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  opts?: CronUpdateOptions,
) {
  const source = captureCronJobMutationSource(state);
  return await locked(state, async () => await updateLoadedJob({ state, source, id, patch, opts }));
}

/** Updates a cron job only after a store-locked caller precondition passes. */
export async function updateWithPrecondition(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  precondition: CronUpdatePrecondition,
  opts?: CronUpdateOptions,
) {
  const source = captureCronJobMutationSource(state);
  return await locked(
    state,
    async () => await updateLoadedJob({ state, source, id, patch, precondition, opts }),
  );
}

/** Removes a cron job by id and re-arms the timer when the in-memory store changes. */
export async function remove(
  state: CronServiceState,
  id: string,
  opts?: { systemOwned?: boolean; commitGuard?: () => void },
) {
  const source = captureCronJobMutationSource(state);
  let sessionCleanup:
    | {
        activeMarker: CronActiveJobMarker | undefined;
        agentId: string;
        sessionStorePath: string;
        finish: () => void;
        release: () => void;
      }
    | undefined;
  const outcome = await locked(state, async () => {
    source.assertCurrent();
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
    source.assertCurrent();
    opts?.commitGuard?.();
    const snapshot = snapshotStoreForRollback(state);
    const previous = structuredClone(state.store);
    const nextStore = { ...previous, jobs: previous.jobs.filter((j) => j.id !== id) };

    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(
      { ...state, store: nextStore },
      {
        deferredNotifications: postPersistNotifications,
      },
    );

    const agentId = resolveCronJobEffectiveAgentId(
      removedJob,
      resolveCurrentDefaultAgentId(state),
      state.deps.legacyDefaultAgentId,
    );
    const sessionStorePath =
      state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
    let activeRunCancellationRequested = false;
    await persistCronJobMutation({
      state,
      source,
      previous: snapshot.store ?? previous,
      next: nextStore,
      method: "cron.remove",
      assertCurrent: opts?.commitGuard,
      postPersistNotifications,
      suppressScheduledJobId: id,
      afterCommit: () => {
        noteActiveCronJobRemoval(id, opts?.commitGuard, (activeMarker) => {
          activeRunCancellationRequested = activeMarker?.cancellation?.kind === "requested";
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
              finish,
              release,
            };
          }
        });
      },
      afterPublish: () => {
        armTimer(state);
        emit(state, { jobId: id, action: "removed", job: removedJob });
      },
    });
    return {
      ok: true,
      removed: true,
      ...(activeRunCancellationRequested ? { activeRunCancellationRequested: true as const } : {}),
    } as const;
  }).then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  if (!sessionCleanup) {
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }
  const { activeMarker, agentId, sessionStorePath, finish, release } = sessionCleanup;
  const cleanup = async () => {
    try {
      const shouldRemove = await locked(state, async () => {
        await ensureLoaded(state);
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
    if (!outcome.ok) {
      throw outcome.error;
    }
    return { ...outcome.value, sessionCleanup: "pending" as const };
  }
  const cleanupError = await cleanup();
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (cleanupError) {
    throw new Error(cleanupError);
  }
  return outcome.value;
}

/** The caller retains its agent-deletion fence while the cron lock joins roster and row writes. */
export async function removeAgentJobsTransactional<T>(
  state: CronServiceState,
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  const source = captureCronServiceMutationSource(state);
  return await locked(state, async () => {
    source.assertCurrent();
    warnIfDisabled(state, "remove agent jobs");
    await ensureLoadedForOperation(state);
    source.assertCurrent();
    const id = normalizeOptionalAgentId(agentId);
    if (!id || !state.store) {
      return await commit();
    }
    const defaultAgentId = resolveCurrentDefaultAgentId(state);
    const previous = structuredClone(state.store);
    const removedJobs = previous.jobs.filter(
      (job) =>
        tryResolveCronJobEffectiveAgentId(job, defaultAgentId, state.deps.legacyDefaultAgentId) ===
        id,
    );
    if (removedJobs.length === 0) {
      return await commit();
    }
    let roster: { value: T } | { error: AgentDeletionCommitUncertainError };
    try {
      roster = { value: await commit() };
    } catch (error) {
      if (!(error instanceof AgentDeletionCommitUncertainError)) {
        throw error;
      }
      roster = { error };
    }
    // Retain the original rows through roster failure. Atomic removal owns scratch and grant
    // revocation too, so failed or uncertain cleanup leaves a complete source for retry.
    const next = structuredClone(previous);
    const removedJobIds = new Set(removedJobs.map((job) => job.id));
    next.jobs = next.jobs.filter((job) => !removedJobIds.has(job.id));
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(
      { ...state, store: next },
      { deferredNotifications: postPersistNotifications },
    );
    try {
      await persistCronJobMutation({
        state,
        source,
        previous,
        next,
        method: "cron.remove",
        postPersistNotifications,
        afterCommit() {
          for (const job of removedJobs) {
            noteActiveCronJobRemoval(job.id);
          }
        },
        afterPublish() {
          armTimer(state);
          for (const job of removedJobs) {
            emit(state, { jobId: job.id, action: "removed", job });
          }
        },
      });
    } catch (error) {
      if ("error" in roster) {
        throw new AgentDeletionCommitUncertainError(
          new AggregateError(
            [roster.error, error],
            "Cron cleanup failed after an uncertain agent roster commit",
            { cause: roster.error },
          ),
        );
      }
      throw new Error("Agent roster committed, but cron cleanup did not complete.", {
        cause: error,
      });
    }
    if ("error" in roster) {
      throw roster.error;
    }
    return roster.value;
  });
}
