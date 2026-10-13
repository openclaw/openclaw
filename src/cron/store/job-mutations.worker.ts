import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { declarativeFields } from "../service/jobs-declarative.js";
import { cloneCronJobForMutation, finalizeUpdatedJob } from "../service/jobs-mutation.js";
import { recomputeSingleJobForMaintenance } from "../service/jobs-scheduling.js";
import {
  reconcileCronChannelRequesterAuthority,
  reconcileRuntimeAuthority,
} from "../service/jobs-tool-policy.js";
import { applyDeclarativeJobSpec, applyJobPatch, createJob } from "../service/jobs.js";
import { isSystemMonitorDeclaration } from "../system-owned-declaration.js";
import type { CronStoredJob, CronStoreFile } from "../types.js";
import type {
  CronJobMutation,
  CronJobMutationPlan,
  CronJobMutationSnapshot,
} from "./job-mutations.types.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { loadCronRuntimeAuthorities } from "./runtime-authority-store.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronSchedulerConfig } from "./scheduler-actor.types.js";
import {
  getCronSchedulerSnapshot,
  installCronSchedulerSnapshot,
} from "./scheduler-config.worker.js";

type CronJobMutationContext = Pick<
  CronSchedulerConfig,
  "defaultAgentId" | "cronConfig" | "configuredChannels"
> & { nowMs: number };

export function resolveCronJobMutationSnapshot(
  storeKey: string,
  snapshot: CronJobMutationSnapshot,
  databasePath: string,
): CronJobMutationContext {
  const configured = (
    snapshot.scheduler
      ? installCronSchedulerSnapshot(storeKey, snapshot.scheduler, databasePath)
      : getCronSchedulerSnapshot(storeKey, databasePath)
  )?.config;
  return configured
    ? {
        ...snapshot,
        defaultAgentId: configured.defaultAgentId,
        cronConfig: configured.cronConfig,
        configuredChannels: configured.configuredChannels,
      }
    : { nowMs: snapshot.nowMs };
}

/** Both preparation and commit use this owner; only committed results are published. */
export function planCronJobMutation(
  previous: CronStoreFile,
  mutation: CronJobMutation,
  snapshot: CronJobMutationContext,
): CronJobMutationPlan {
  const next: CronStoreFile = { version: 1, jobs: previous.jobs.map(cloneCronJobForMutation) };
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
        if (options.createdActor) {
          nextJob.createdActor = structuredClone(options.createdActor);
        }
        if (options.sourceConversation) {
          nextJob.sourceConversation = structuredClone(options.sourceConversation);
        }
        if (options.skillLibrarySelections) {
          nextJob.skillLibrarySelections = structuredClone(options.skillLibrarySelections);
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
      finalizeUpdatedJob({
        job: previousJob,
        nextJob,
        now,
        schedulingInputsRequested:
          mutation.patch.schedule !== undefined ||
          mutation.patch.enabled !== undefined ||
          "trigger" in mutation.patch ||
          "pacing" in mutation.patch,
        scheduleChanged: mutation.patch.schedule !== undefined,
        explicitTriggerState: mutation.patch.state,
        isJobActive: () => previousJob?.state.runningAtMs !== undefined,
      });
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
    reconcileCronChannelRequesterAuthority({
      job: nextJob,
      previousJob,
      toolsAllowProvenance: options.toolsAllowProvenance,
      reauthorize: mutation.kind === "add" || explicitlyMutatesToolsAllow,
      reauthorizeCallerOrigin: mutation.kind === "update" && explicitlyMutatesToolsAllow,
    });
    resolveCronJobEffectiveAgentId(nextJob, defaultAgentId);
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

export function prepareCronJobMutationInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.prepareJobMutation"]["input"],
): CronRuntimeWorkerOperations["cron.prepareJobMutation"]["output"] {
  const snapshot = resolveCronJobMutationSnapshot(input.storeKey, input.snapshot, database.path);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const store = loadedCronStoreFromRows(loadCronRows(db, input.storeKey)).store;
      loadCronRuntimeAuthorities({ db, storeKey: input.storeKey, jobs: store.jobs });
      return { outcome: planCronJobMutation(store, input.mutation, snapshot) };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.prepare-job-mutation" },
  );
}
