import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { declarativeFields } from "../service/jobs-declarative.js";
import {
  applyCronStreamSandboxTarget,
  cloneCronJobForMutation,
  finalizeUpdatedJob,
} from "../service/jobs-mutation.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import {
  reconcileCronChannelRequesterAuthority,
  reconcileCronOperatorSource,
  reconcileRuntimeAuthority,
} from "../service/jobs-tool-policy.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "../service/jobs.js";
import { isSystemMonitorDeclaration } from "../system-owned-declaration.js";
import type { CronStoredJob, CronStoreFile } from "../types.js";
import type { CronJobMutation, CronJobMutationPlan } from "./job-mutations.types.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type { CronSchedulerConfig } from "./scheduler-actor.types.js";

type CronJobMutationContext = Pick<
  CronSchedulerConfig,
  "defaultAgentId" | "cronConfig" | "configuredChannels"
> & { nowMs: number };

/** Both preparation and commit use this owner; only committed results are published. */
export function planCronJobMutation(
  previous: CronStoreFile,
  mutation: CronJobMutation,
  snapshot: CronJobMutationContext,
): CronJobMutationPlan {
  const next: CronStoreFile = { version: 1, jobs: [...previous.jobs] };
  const plan: CronJobMutationPlan = { previous, next, notifications: [], logs: [] };
  const { nowMs: now, defaultAgentId, cronConfig, configuredChannels } = snapshot;
  if (mutation.kind === "remove") {
    const ids = new Set(mutation.ids);
    for (const job of next.jobs) {
      if (
        ids.has(job.id) &&
        isSystemMonitorDeclaration(job.declarationKey) &&
        !mutation.systemOwned
      ) {
        throw new Error("system-owned monitor jobs cannot be removed by cron clients");
      }
    }
    next.jobs = next.jobs.filter((job) => !ids.has(job.id));
  } else {
    const options = mutation.options;
    const validation = { ...options, defaultAgentId, cronConfig, configuredChannels };
    let previousJob: CronStoredJob | undefined;
    let nextJob: CronStoredJob;
    if (mutation.kind === "add") {
      const key = normalizeOptionalString(mutation.input.declarationKey);
      const matches = key
        ? previous.jobs.filter(
            (job) =>
              job.declarationKey === key &&
              (!mutation.matchingJobIds || mutation.matchingJobIds.includes(job.id)),
          )
        : [];
      if (matches.length > 1) {
        throw new Error(`cron declarationKey is ambiguous within caller scope: ${key}`);
      }
      previousJob = matches[0];
      if (previousJob) {
        nextJob = cloneCronJobForMutation(previousJob);
        applyDeclarativeJobSpec(nextJob, mutation.input, {
          ...validation,
          scheduledToolPolicy: options.scheduledToolPolicy ?? undefined,
          enabledExplicit: options.enabledExplicit === true,
          nowMs: now,
        });
        applyCronStreamSandboxTarget(nextJob, options.streamSandbox);
        finalizeUpdatedJob({
          job: previousJob,
          nextJob,
          now,
          schedulingInputsRequested: true,
          scheduleChanged: !isDeepStrictEqual(previousJob.schedule, nextJob.schedule),
          explicitTriggerState: mutation.input.state,
          isJobActive: () => previousJob?.state.runningAtMs !== undefined,
        });
      } else {
        if (next.jobs.some((job) => job.id === mutation.input.id)) {
          throw new Error(`cron job already exists: ${mutation.input.id}`);
        }
        nextJob = createJob(
          { deps: { nowMs: () => now, defaultAgentId, cronConfig } },
          mutation.input,
          {
            ...validation,
            scheduledToolPolicy: options.scheduledToolPolicy ?? undefined,
          },
        );
        applyCronStreamSandboxTarget(nextJob, options.streamSandbox);
        if (options.createdActor) {
          nextJob.createdActor = options.createdActor;
        }
        if (options.sourceConversation) {
          nextJob.sourceConversation = options.sourceConversation;
        }
        if (options.skillLibrarySelections) {
          nextJob.skillLibrarySelections = options.skillLibrarySelections;
        }
      }
    } else {
      previousJob = previous.jobs.find((job) => job.id === mutation.id);
      if (!previousJob) {
        throw new Error(`unknown cron job id: ${mutation.id}`);
      }
      if (isSystemMonitorDeclaration(previousJob.declarationKey)) {
        throw new Error("system-owned monitor jobs cannot be edited by cron clients");
      }
      nextJob = cloneCronJobForMutation(previousJob);
      applyJobPatch(nextJob, mutation.patch, { ...validation, scheduleValidationNowMs: now });
      applyCronStreamSandboxTarget(nextJob, options.streamSandbox);
      finalizeUpdatedJob({
        job: previousJob,
        nextJob,
        now,
        schedulingInputsRequested:
          mutation.patch.schedule !== undefined ||
          options.streamSandbox !== undefined ||
          mutation.patch.enabled !== undefined ||
          "trigger" in mutation.patch ||
          "pacing" in mutation.patch,
        scheduleChanged: mutation.patch.schedule !== undefined,
        explicitTriggerState: mutation.patch.state,
        streamRestartExhaustedRequested: mutation.patch.state?.streamRestartExhausted === true,
        isJobActive: () => previousJob?.state.runningAtMs !== undefined,
      });
    }
    // Declarative re-registration is not a fresh authorization of an existing account.
    if (options.inferenceBinding && (!previousJob || mutation.kind === "update")) {
      nextJob.inferenceBinding = options.inferenceBinding;
    }
    const explicitlyMutatesToolsAllow =
      mutation.kind === "add"
        ? mutation.input.payload.toolsAllow !== undefined
        : mutation.patch.payload !== undefined &&
          Object.hasOwn(mutation.patch.payload, "toolsAllow");
    reconcileRuntimeAuthority({
      job: nextJob,
      captured: options.captured,
      runtimeAuthority: options.runtimeAuthority,
      explicitlyMutatesToolsAllow,
    });
    if (nextJob.runtimeAuthority) {
      // Native inference authority replaces, rather than supplements, host credentials.
      delete nextJob.inferenceBinding;
    }
    reconcileCronChannelRequesterAuthority({
      job: nextJob,
      previousJob,
      toolsAllowProvenance: options.toolsAllowProvenance,
      reauthorize: mutation.kind === "add" || explicitlyMutatesToolsAllow,
      reauthorizeCallerOrigin: mutation.kind === "update" && explicitlyMutatesToolsAllow,
    });
    resolveCronJobEffectiveAgentId(nextJob, defaultAgentId);
    reconcileCronOperatorSource({ job: nextJob, previousJob, captured: options.operatorSource });
    plan.created = !previousJob;
    plan.updated =
      previousJob !== undefined &&
      (mutation.kind === "update" ||
        !isDeepStrictEqual(
          declarativeFields(previousJob, options.enabledExplicit === true),
          declarativeFields(nextJob, options.enabledExplicit === true),
        ));
    if (!previousJob) {
      next.jobs.push(nextJob);
    } else if (plan.updated) {
      next.jobs = next.jobs.map((job) => (job.id === nextJob.id ? nextJob : job));
    }
    plan.job = nextJob;
  }
  if (mutation.kind === "remove" || plan.created) {
    // Only maintenance mutates untouched rows; ordinary edits clone their target above.
    next.jobs = next.jobs.map((job) => (job === plan.job ? job : cloneCronJobForMutation(job)));
    const policy = { deps: { nowMs: () => now, log: createCronMutationLogger(plan.logs) } };
    const reservations = new Map(
      next.jobs.flatMap((job) =>
        job.state.queuedAtMs === undefined
          ? []
          : [[job.id, { markerAtMs: job.state.queuedAtMs, preserveWhenDisabled: true }] as const],
      ),
    );
    for (const job of next.jobs) {
      recomputeSingleJobForMaintenance(
        policy,
        job,
        { deferredNotifications: plan.notifications },
        {
          reservations,
          isJobActive: (id) =>
            next.jobs.some(
              (candidate) => candidate.id === id && candidate.state.runningAtMs !== undefined,
            ),
        },
      );
    }
  }
  return plan;
}
