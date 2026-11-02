import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { assertCronBindApplies } from "../bind-parent.js";
import { retireTransferredCronAuthority } from "../human-owner.js";
import {
  decodePluginCommandSchedule,
  isPluginCommandScheduleCapPeer,
  MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT,
} from "../plugin-command-schedule.js";
import { toPublicCronJob } from "../public-job.js";
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
  resolveCronOperatorExecutionRevision,
  reconcileRuntimeAuthority,
} from "../service/jobs-tool-policy.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "../service/jobs.js";
import type { CronStoredJob, CronStoreFile } from "../types.js";
import type { CronJobMutation, CronJobMutationPlan } from "./job-mutations.types.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type { CronSchedulerConfig } from "./scheduler-actor.types.js";

type CronJobMutationContext = Pick<
  CronSchedulerConfig,
  "defaultAgentId" | "cronConfig" | "configuredChannels"
> & { nowMs: number };

function commandDeclarationDefinition(job: CronStoredJob): unknown {
  const {
    id: _id,
    createdAtMs: _createdAtMs,
    updatedAtMs: _updatedAtMs,
    state: _state,
    // Derived from the envelope, which the caller compares separately; a candidate has none yet.
    payloadSource: _payloadSource,
    ...definition
  } = toPublicCronJob(job);
  // Compare the stored JSON contract, not omitted-versus-undefined JS properties.
  // structuredClone preserves undefined fields and would change declaration equality.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(definition));
}

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
    next.jobs = next.jobs.filter((job) => !ids.has(job.id));
  } else {
    const options = mutation.options;
    const validation = { ...options, defaultAgentId, cronConfig, configuredChannels };
    let previousJob: CronStoredJob | undefined;
    let nextJob: CronStoredJob;
    if (mutation.kind === "add") {
      if (Object.hasOwn(mutation.input, "pluginCommand")) {
        throw new Error("plugin command schedules require private creation options");
      }
      const pluginCommand =
        options.pluginCommand === undefined
          ? undefined
          : decodePluginCommandSchedule(options.pluginCommand);
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
      if (previousJob && (previousJob.pluginCommand !== undefined || pluginCommand !== undefined)) {
        const existingCommandJob = previousJob;
        // A declaration retry is never fresh authority or a fresh run budget.
        const candidate = createJob(
          { deps: { nowMs: () => existingCommandJob.createdAtMs, defaultAgentId, cronConfig } },
          mutation.input,
          { ...validation, scheduledToolPolicy: options.scheduledToolPolicy ?? undefined },
        );
        applyCronStreamSandboxTarget(candidate, options.streamSandbox);
        if (
          !isDeepStrictEqual(previousJob.pluginCommand, pluginCommand) ||
          !isDeepStrictEqual(
            commandDeclarationDefinition(previousJob),
            commandDeclarationDefinition(candidate),
          ) ||
          Object.keys(mutation.input.state ?? {}).length > 0
        ) {
          throw new Error(
            "plugin command declaration already exists and cannot be changed or rearmed",
          );
        }
        plan.job = previousJob;
        plan.created = false;
        plan.updated = false;
        return plan;
      }
      if (
        pluginCommand &&
        previous.jobs.filter((job) =>
          isPluginCommandScheduleCapPeer(
            job,
            pluginCommand,
            now,
            options.pluginCommandSourceDigest,
          ),
        ).length >= MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT
      ) {
        // Retired schedules, those bound to a replaced plugin instance or other code, and
        // non-restartable ones of an earlier Gateway process do not count: none can run again.
        throw new Error(
          `plugin command schedules are limited to ${MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT} active jobs per plugin and parent session`,
        );
      }
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
            createdAtMs: mutation.createdAtMs,
            scheduledToolPolicy: options.scheduledToolPolicy ?? undefined,
          },
        );
        applyCronStreamSandboxTarget(nextJob, options.streamSandbox);
        if (pluginCommand) {
          nextJob.pluginCommand = pluginCommand;
          nextJob.state.pluginCommandRuns = 0;
          // Restart continuity: a later Gateway process can re-arm this schedule at its claim
          // onto an instance that loaded exactly this code. Without captured source it ends with
          // this process, as on hosts without continuity.
          if (options.pluginCommandSourceDigest) {
            nextJob.state.pluginCommandBinding = {
              hostProcessId: pluginCommand.hostProcessId,
              pluginIncarnation: pluginCommand.pluginIncarnation,
              sourceDigest: options.pluginCommandSourceDigest,
            };
          }
        }
        if (options.createdActor) {
          nextJob.createdActor = options.createdActor;
          if (options.createdActor.type === "human" && options.createdActor.source === "profile") {
            nextJob.ownerProfileId = options.createdActor.id;
          }
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
      if (
        previousJob.pluginCommand !== undefined &&
        (mutation.patch.enabled !== false || Object.keys(mutation.patch).length !== 1)
      ) {
        throw new Error("plugin command jobs can only be disabled or removed, not edited");
      }
      nextJob = cloneCronJobForMutation(previousJob);
      applyJobPatch(nextJob, mutation.patch, { ...validation, scheduleValidationNowMs: now });
      if (options.bindSourceConversation) {
        assertCronBindApplies(previousJob, options.bindSourceConversation);
        nextJob.sourceConversation = { ...options.bindSourceConversation };
      }
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
    if (previousJob?.pluginCommand !== undefined) {
      // Disable preserves the original envelope, requester authority, and attempt count.
      plan.job = nextJob;
      plan.created = false;
      plan.updated = true;
      next.jobs = next.jobs.map((job) => (job.id === nextJob.id ? nextJob : job));
      return plan;
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
    // Neither an ordinary edit nor an app-only recovery flag proves fresh inference consent.
    // Capture is admitted and rechecked by the caller's existing mutation commit guard.
    if (mutation.kind === "update" && (options.runtimeAuthority || options.inferenceBinding)) {
      delete nextJob.ownerTransferPending;
    }
    if (nextJob.runtimeAuthority) {
      // Native inference authority replaces, rather than supplements, host credentials.
      delete nextJob.inferenceBinding;
    }
    reconcileCronChannelRequesterAuthority({
      job: nextJob,
      // Bind only records the parent link; the authenticated requester stays bound to an
      // unchanged executable definition, so compare against the same link.
      previousJob:
        previousJob && options.bindSourceConversation
          ? { ...previousJob, sourceConversation: nextJob.sourceConversation }
          : previousJob,
      toolsAllowProvenance: options.toolsAllowProvenance,
      reauthorize: mutation.kind === "add" || explicitlyMutatesToolsAllow,
      reauthorizeCallerOrigin: mutation.kind === "update" && explicitlyMutatesToolsAllow,
    });
    resolveCronJobEffectiveAgentId(nextJob, defaultAgentId);
    reconcileCronOperatorSource({
      job: nextJob,
      previousJob,
      captured: options.operatorSource,
      capturedExecutionRevision:
        mutation.kind === "add"
          ? resolveCronOperatorExecutionRevision(nextJob)
          : options.operatorSourceExecutionRevision,
      defaultAgentId,
    });
    if (previousJob && nextJob.ownerProfileId !== previousJob.ownerProfileId) {
      retireTransferredCronAuthority(nextJob);
    }
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
