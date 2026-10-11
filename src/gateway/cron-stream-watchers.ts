import { resolveCronTriggerMinIntervalMs } from "../config/cron-limits.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { assertCanonicalCronDeliveryMode } from "../cron/store/delivery-codec.js";
import type { CronJob, CronJobState } from "../cron/types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  CronStreamJobOwner,
  isCronStreamJob,
  type CronStreamOwnerParams,
  type CronStreamOwnerSnapshot,
  type CronStreamStopReason,
} from "./cron-stream-job-owner.js";
import type { CronStreamJob } from "./cron-stream-output.js";

export type { CronStreamFireDisposition } from "./cron-stream-output.js";

const MAX_RETIRED_COUNTER_SEEDS = 1_024;

type CronStreamWatchers = {
  reconcile: (jobs: CronJob[], enabled: boolean, triggersEnabled?: boolean) => Promise<void>;
  resume: () => void;
  start: (job: CronJob) => Promise<void>;
  stop: (jobId: string, reason: CronStreamStopReason, job?: CronJob) => Promise<void>;
  stopAll: (reason: CronStreamStopReason) => Promise<void>;
  activeJobIds: () => string[];
  inspect: (jobId: string) => CronStreamOwnerSnapshot | undefined;
};

/** Keep direct mutations and reconcile decisions on the same stop-reason contract. */
export function resolveStreamStopReason(input: {
  triggersEnabled: boolean;
  cronEnabled: boolean;
  restartExhausted: boolean;
  isStream: boolean;
}): CronStreamStopReason {
  if (!input.triggersEnabled) {
    return "trust-disabled";
  }
  if (!input.cronEnabled) {
    return "cron-disabled";
  }
  if (input.restartExhausted) {
    return "restart-exhausted";
  }
  return input.isStream ? "disabled" : "schedule-update";
}

/** Supervise line-producing cron sources through one serialized owner per job. */
export function createCronStreamWatchers(
  params: Omit<CronStreamOwnerParams, "minIntervalMs"> & {
    /** Test seams; production uses the built-in cadence and retry schedules. */
    minIntervalMs?: number;
  },
): CronStreamWatchers {
  const owners = new Map<string, CronStreamJobOwner>();
  const retiredCounterSeeds = new Map<
    string,
    Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">
  >();
  let stopped = false;

  const ownerParams: CronStreamOwnerParams = {
    ...params,
    minIntervalMs: params.minIntervalMs ?? resolveCronTriggerMinIntervalMs(),
  };

  const retainCounterSeed = (owner: CronStreamJobOwner): void => {
    const snapshot = owner.snapshot();
    const current = retiredCounterSeeds.get(owner.id);
    retiredCounterSeeds.delete(owner.id);
    retiredCounterSeeds.set(owner.id, {
      streamDroppedBatches: Math.max(current?.streamDroppedBatches ?? 0, snapshot.droppedBatches),
      streamCoalescedBatches: Math.max(
        current?.streamCoalescedBatches ?? 0,
        snapshot.coalescedBatches,
      ),
    });
    pruneMapToMaxSize(retiredCounterSeeds, MAX_RETIRED_COUNTER_SEEDS);
  };

  const createOwner = (job: CronStreamJob): CronStreamJobOwner => {
    const seed = retiredCounterSeeds.get(job.id);
    retiredCounterSeeds.delete(job.id);
    const seededJob = seed
      ? {
          ...job,
          state: {
            ...job.state,
            streamDroppedBatches: Math.max(
              job.state.streamDroppedBatches ?? 0,
              seed.streamDroppedBatches ?? 0,
            ),
            streamCoalescedBatches: Math.max(
              job.state.streamCoalescedBatches ?? 0,
              seed.streamCoalescedBatches ?? 0,
            ),
          },
        }
      : job;
    const owner = new CronStreamJobOwner(seededJob, ownerParams);
    owners.set(job.id, owner);
    return owner;
  };

  const getOrCreateOwner = async (job: CronStreamJob): Promise<CronStreamJobOwner | undefined> => {
    while (true) {
      if (stopped) {
        return undefined;
      }
      const existing = owners.get(job.id);
      if (existing?.acceptsStart()) {
        return existing;
      }
      if (!existing) {
        return createOwner(job);
      }
      // Watcher-internal disposal of an obsolete owner, not a durable removal:
      // a retiring "removed" stop would rotate the live job's identity and
      // strand the replacement built from this snapshot behind the CAS guard.
      await existing.stop("schedule-update");
      if (stopped) {
        return undefined;
      }
      if (owners.get(job.id) === existing) {
        retainCounterSeed(existing);
        owners.delete(job.id);
      }
    }
  };

  const stop = async (
    jobId: string,
    reason: CronStreamStopReason,
    job?: CronJob,
  ): Promise<void> => {
    const streamJob = job && isCronStreamJob(job) ? job : undefined;
    const owner =
      owners.get(jobId) ?? (reason !== "removed" && streamJob ? createOwner(streamJob) : undefined);
    if (!owner) {
      return;
    }
    await owner.stop(reason, streamJob);
    if (reason === "removed" && owners.get(jobId) === owner) {
      retainCounterSeed(owner);
      owners.delete(jobId);
    }
  };

  const start = async (job: CronJob): Promise<void> => {
    if (stopped) {
      return;
    }
    if (!isCronStreamJob(job)) {
      await stop(job.id, "schedule-update");
      return;
    }
    try {
      assertCanonicalCronDeliveryMode(job.delivery);
      resolveCronJobEffectiveAgentId(job, params.getDefaultAgentId?.());
    } catch (error) {
      if (owners.has(job.id)) {
        await stop(job.id, "disabled", job);
      }
      throw error;
    }
    const owner = await getOrCreateOwner(job);
    if (!owner || stopped) {
      return;
    }
    await owner.start(job);
  };

  // Stop with the failure contained: owner.stop() applies its synchronous
  // admission fence when called, so callers that must fence *every* source
  // (reconcile, shutdown) initiate all stops first and log stragglers instead
  // of letting one stubborn child reject the whole sweep.
  const stopOwnerLogged = async (
    owner: CronStreamJobOwner,
    reason: CronStreamStopReason,
    job?: CronStreamJob,
  ): Promise<boolean> => {
    try {
      await owner.stop(reason, job);
      return true;
    } catch (error) {
      params.logger.warn(
        { jobId: owner.id, reason, err: String(error) },
        "cron-stream: owner stop failed",
      );
      return false;
    }
  };

  const stopAll = async (reason: CronStreamStopReason): Promise<void> => {
    if (reason === "shutdown") {
      stopped = true;
    }
    // Every stop is initiated before any await, so each owner's synchronous
    // fence and scope pre-cancel fire even when a sibling stop later rejects.
    // Settlement is a barrier: shutdown must not resolve (or reject) while any
    // owner teardown is still in flight, so failures surface only after all
    // owners settled.
    const settled = await Promise.allSettled(
      Array.from(owners.values(), (owner) => owner.stop(reason)),
    );
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "stream owner stops failed");
    }
  };

  const reconcile = async (
    jobs: CronJob[],
    enabled: boolean,
    triggersEnabled = enabled,
  ): Promise<void> => {
    if (stopped) {
      return;
    }
    const streamJobs = jobs.filter(isCronStreamJob);
    const wantedIds = new Set(streamJobs.map((job) => job.id));
    // One failing stop must not abort the sweep: each stop is bounded, its
    // scope pre-cancel fires when initiated, and stopOwnerLogged contains the
    // rejection so every remaining owner still gets fenced and stopped.
    for (const [jobId, owner] of owners.entries()) {
      if (wantedIds.has(jobId)) {
        continue;
      }
      if (stopped) {
        return;
      }
      if (await stopOwnerLogged(owner, "removed")) {
        if (owners.get(jobId) === owner) {
          retainCounterSeed(owner);
          owners.delete(jobId);
        }
      }
    }

    for (const job of streamJobs) {
      const owner = await getOrCreateOwner(job);
      if (!owner) {
        return;
      }
      if (stopped) {
        return;
      }
      const stopReason = !enabled
        ? triggersEnabled
          ? "cron-disabled"
          : "trust-disabled"
        : !job.enabled
          ? "disabled"
          : job.state.streamRestartExhausted
            ? "restart-exhausted"
            : undefined;
      if (stopReason) {
        await stopOwnerLogged(owner, stopReason, job);
        continue;
      }
      try {
        await start(job);
      } catch (error) {
        // A schedule replacement can reject when the old child refuses to
        // exit; contain it like the stop branches so one stubborn source
        // cannot leave the remaining jobs unreconciled.
        params.logger.warn(
          { jobId: job.id, err: String(error) },
          "cron-stream: reconcile start failed",
        );
      }
    }
  };

  return {
    reconcile,
    resume: () => {
      stopped = false;
    },
    start,
    stop,
    stopAll,
    activeJobIds: () =>
      Array.from(owners.values())
        .filter((owner) => {
          const state = owner.snapshot().state;
          return (
            state === "starting" ||
            state === "running" ||
            state === "stopping" ||
            state === "backoff"
          );
        })
        .map((owner) => owner.id),
    inspect: (jobId) => owners.get(jobId)?.snapshot(),
  };
}
