import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { AgentDeletionCommitUncertainError } from "../../agents/agent-lifecycle-registry.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import {
  type CronActiveJobMarker,
  noteActiveCronJobRemoval,
  onCronJobInactive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId, tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../config-revision.js";
import { normalizeCronRunJobId } from "../run-history.js";
import { removeCronJobBaseSession } from "../session-reaper.js";
import { removeStaleCronJobFamilyRows } from "../store.js";
import type { CronJobMutation } from "../store/job-mutations.types.js";
import { systemOwnedDeclarationKeyNamespace } from "../system-owned-declaration.js";
import type { CronJobCreate, CronJobPatch } from "../types.js";
import { declarativeFields } from "./jobs-declarative.js";
import { persistUpdatedJob } from "./jobs-mutation-persistence.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import {
  consumeRuntimeAuthorityMutationOptions,
  reconcileRuntimeAuthority,
} from "./jobs-tool-policy.js";
import {
  cronPatchTouchesDeliveryResolution,
  resolveConfiguredChannelsForValidation,
} from "./jobs-validation.js";
import {
  getPendingCronSessionCleanup,
  locked,
  registerPendingCronSessionCleanup,
} from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { resolveCurrentDefaultAgentId } from "./ops-shared.js";
import { captureCronSchedulerSnapshot } from "./scheduler-config.js";
import type {
  CronAddOptions,
  CronAddResult,
  CronRemoveOptions,
  CronServiceState,
  CronUpdateOptions,
  CronUpdatePrecondition,
} from "./state.js";
import { emit } from "./state.js";
import {
  captureCronJobMutationSource,
  captureCronServiceMutationSource,
  ensureLoaded,
  ensureLoadedForOperation,
  persistCronJobMutation,
  prepareCronJobMutation,
  warnIfDisabled,
} from "./store.js";

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
    const configuredChannels = await resolveConfiguredChannelsForValidation(state);
    source.assertCurrent();
    const mutation: CronJobMutation = {
      kind: "add",
      createdAtMs: opts?.streamExecApproval?.createdAtMs,
      input: { ...normalizedInput, id: normalizedId ?? crypto.randomUUID() },
      matchingJobIds: opts?.matchesExisting
        ? (state.store?.jobs.filter(opts.matchesExisting).map((job) => job.id) ?? [])
        : undefined,
      options: {
        pluginCommand: opts?.pluginCommand,
        pluginCommandSourceDigest: opts?.pluginCommandSourceDigest,
        streamSandbox: opts?.streamSandbox,
        enabledExplicit: opts?.enabledExplicit,
        systemOwned: opts?.systemOwned,
        createdActor: opts?.createdActor,
        inferenceBinding: opts?.inferenceBinding,
        sourceConversation: opts?.sourceConversation,
        operatorSource: opts?.operatorSource,
        skillLibrarySelections: opts?.skillLibrarySelections,
        scheduledToolPolicy: opts?.scheduledToolPolicy,
        toolsAllowProvenance: opts?.toolsAllowProvenance,
        toolsAllowExecTarget: opts?.toolsAllowExecTarget,
        captured: false,
      },
    };
    const mutationSnapshot = {
      nowMs: state.deps.nowMs(),
      scheduler: await captureCronSchedulerSnapshot(state, configuredChannels, source),
    };
    const plan = await prepareCronJobMutation(state, source, mutation, mutationSnapshot);
    if (!plan.job) {
      throw new Error("Cron add produced no job");
    }
    const job = plan.job;
    const existing = plan.previous.jobs.find((entry) => entry.id === job.id);
    const captured = consumeRuntimeAuthorityMutationOptions(opts);
    Object.assign(mutation.options, captured);
    if (!existing?.pluginCommand) {
      reconcileRuntimeAuthority({
        job,
        ...captured,
        explicitlyMutatesToolsAllow: normalizedInput.payload.toolsAllow !== undefined,
      });
    }
    plan.updated =
      existing !== undefined &&
      !isDeepStrictEqual(
        declarativeFields(existing, opts?.enabledExplicit === true),
        declarativeFields(job, opts?.enabledExplicit === true),
      );
    if (existing && plan.updated) {
      const committedJob = await persistUpdatedJob({
        state,
        source,
        previousJob: existing,
        nextJob: job,
        commitGuard: opts?.commitGuard,
        streamAuthority: opts,
        agentId,
        mutationMethod: "cron.add",
        jobMutation: mutation,
        jobMutationSnapshot: mutationSnapshot,
      });
      return { ...committedJob, created: false, updated: true, job: committedJob };
    }
    await persistCronJobMutation({
      state,
      source,
      method: "cron.add",
      assertCurrent: opts?.commitGuard,
      streamAuthority: opts,
      agentId,
      expectedJob: existing
        ? { id: existing.id, configRevision: resolveCronJobConfigRevision(existing) }
        : undefined,
      jobMutation: mutation,
      jobMutationSnapshot: mutationSnapshot,
      suppressScheduledJobId: job.id,
      afterPublish: () => {
        if (!plan.created) {
          return;
        }
        const committedJob = findJobOrThrow(state, job.id);
        state.deps.log.info(
          {
            jobId: job.id,
            jobName: committedJob.name,
            nextRunAtMs: committedJob.state.nextRunAtMs,
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
    return declarationKey
      ? {
          ...committedJob,
          created: plan.created === true,
          ...(existing ? { updated: false } : {}),
          job: committedJob,
        }
      : committedJob;
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
  await ensureLoadedForOperation(state);
  const job = findJobOrThrow(state, id);
  const now = state.deps.nowMs();
  const configuredChannels = cronPatchTouchesDeliveryResolution(patch)
    ? await resolveConfiguredChannelsForValidation(state)
    : undefined;
  await precondition?.(structuredClone(job), now);
  source.assertCurrent();
  const mutation: CronJobMutation = {
    kind: "update",
    id,
    patch,
    options: {
      streamSandbox: opts?.streamSandbox,
      operatorSource: opts?.operatorSource,
      operatorSourceExecutionRevision: opts?.operatorSourceExecutionRevision,
      inferenceBinding: opts?.inferenceBinding,
      scheduledToolPolicy: opts?.scheduledToolPolicy,
      toolsAllowProvenance: opts?.toolsAllowProvenance,
      toolsAllowExecTarget: opts?.toolsAllowExecTarget,
      captured: false,
    },
  };
  const mutationSnapshot = {
    nowMs: now,
    scheduler: await captureCronSchedulerSnapshot(state, configuredChannels, source),
  };
  const plan = await prepareCronJobMutation(state, source, mutation, mutationSnapshot);
  const nextJob = plan.job;
  const previousJob = plan.previous.jobs.find((entry) => entry.id === id);
  if (!nextJob || !previousJob) {
    throw new Error(`unknown cron job id: ${id}`);
  }
  const captured = consumeRuntimeAuthorityMutationOptions(opts);
  Object.assign(mutation.options, captured);
  if (!previousJob.pluginCommand) {
    reconcileRuntimeAuthority({
      job: nextJob,
      ...captured,
      explicitlyMutatesToolsAllow:
        patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
    });
  }
  source.assertCurrent();
  return await persistUpdatedJob({
    state,
    previousJob,
    nextJob,
    source,
    commitGuard: opts?.commitGuard,
    streamAuthority: opts,
    agentId:
      patch.agentId !== undefined
        ? resolveCronJobEffectiveAgentId(nextJob, resolveCurrentDefaultAgentId(state))
        : undefined,
    preconditionJob: precondition ? job : undefined,
    mutationMethod: "cron.update",
    jobMutation: mutation,
    jobMutationSnapshot: mutationSnapshot,
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

/** Removes a cron job through its worker owner before canceling and cleaning up host work. */
export async function remove(state: CronServiceState, id: string, opts?: CronRemoveOptions) {
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
    await ensureLoadedForOperation(state);
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    const removedJob = state.store.jobs.find((j) => j.id === id);
    if (!removedJob) {
      return { ok: true, removed: false } as const;
    }
    if (opts?.expectedConfigRevision !== undefined) {
      const actualConfigRevision = resolveCronJobConfigRevision(removedJob);
      if (actualConfigRevision !== opts.expectedConfigRevision) {
        throw new CronJobConfigRevisionConflictError(
          opts.expectedConfigRevision,
          actualConfigRevision,
        );
      }
    }
    source.assertCurrent();
    opts?.commitGuard?.();

    const agentId = resolveCronJobEffectiveAgentId(removedJob, resolveCurrentDefaultAgentId(state));
    const sessionStorePath =
      state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
    let activeRunCancellationRequested = false;
    await persistCronJobMutation({
      state,
      source,
      method: "cron.remove",
      assertCurrent: opts?.commitGuard,
      ...(opts?.expectedConfigRevision !== undefined
        ? { expectedJob: { id, configRevision: opts.expectedConfigRevision } }
        : {}),
      jobMutation: { kind: "remove", ids: [id], systemOwned: opts?.systemOwned },
      jobMutationSnapshot: {
        nowMs: state.deps.nowMs(),
        scheduler: await captureCronSchedulerSnapshot(state),
      },
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
    onCronJobInactive(activeMarker, () => void trackAsyncWork(cleanup));
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
    const removedJobs = state.store.jobs.filter(
      (job) => tryResolveCronJobEffectiveAgentId(job, defaultAgentId) === id,
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
    const removedJobIds = new Set(removedJobs.map((job) => job.id));
    try {
      await persistCronJobMutation({
        state,
        source,
        method: "cron.remove",
        jobMutation: { kind: "remove", ids: [...removedJobIds], systemOwned: true },
        jobMutationSnapshot: {
          nowMs: state.deps.nowMs(),
          scheduler: await captureCronSchedulerSnapshot(state),
        },
        afterCommit() {
          for (const job of removedJobs) {
            noteActiveCronJobRemoval(job.id);
          }
        },
        afterPublish() {
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
