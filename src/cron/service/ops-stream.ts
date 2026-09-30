import { isDeepStrictEqual } from "node:util";
import { assertCronJobStateTimestamps } from "../persisted-shape.js";
import { noteCronJobsStoreCommit } from "../store.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type { CronExternalStateChange } from "../store/runtime-worker.types.js";
import {
  CronStreamSourceRetirementError,
  createCronStreamSourceIdentity,
  ownsStreamSource,
} from "../stream-schedule.js";
import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState, resolveFailureAlert } from "./failure-alerts.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import {
  captureCronJobMutationSource,
  ensureLoaded,
  runPostPersistCronNotifications,
} from "./store.js";
import { armTimer } from "./timer.js";

type ExternalOutcome = CronRuntimeMutationContracts["cron.mutateExternalState"]["outcome"];

async function mutateExternalState(
  state: CronServiceState,
  jobId: string,
  requested: CronExternalStateChange,
): Promise<CronJob | undefined> {
  const source = captureCronJobMutationSource(state);
  const change = structuredClone(requested);
  return await locked(state, async () => {
    source.assertCurrent();
    await ensureLoaded(state);
    source.assertCurrent();
    if (change.kind === "failure") {
      const job = findJobOrThrow(state, jobId);
      if (
        change.source &&
        !ownsStreamSource(job, change.source.scheduleKey, change.source.identity)
      ) {
        return undefined;
      }
    }
    if (change.kind === "state" || change.kind === "failure") {
      assertCronJobStateTimestamps(change.statePatch);
    }
    let committed: ExternalOutcome | undefined;
    let retiredIdentity: string | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await runCronRuntimeMutation({
        context: source.context,
        type: "cron.mutateExternalState",
        input: { storeKey: source.storeKey, jobId, change },
        assertCurrent: () => source.assertCurrent(),
        prepare(routing) {
          if (routing.id !== jobId) {
            throw new Error("Cron external policy differs from its admitted job");
          }
          const cronConfig =
            change.kind === "failure" ? structuredClone(state.deps.cronConfig) : undefined;
          const value = {
            nowMs: state.deps.nowMs(),
            cronConfig,
            failureAlert:
              change.kind === "failure"
                ? resolveFailureAlert({ deps: { cronConfig } }, routing)
                : null,
          };
          return {
            value,
            assertCurrent() {
              source.assertCurrent();
              if (
                change.kind === "failure" &&
                (!isDeepStrictEqual(cronConfig, state.deps.cronConfig) ||
                  !isDeepStrictEqual(value.failureAlert, resolveFailureAlert(state, routing)))
              ) {
                throw new Error("Cron external failure policy changed before commit");
              }
            },
          };
        },
        publish(outcome) {
          committed = outcome;
          if (outcome.job) {
            noteCronJobsStoreCommit(source.storeKey);
          }
        },
      });
    } catch (error) {
      // A missing outcome cannot certify that the resident row is still current.
      noteCronJobsStoreCommit(source.storeKey);
      failure = { error };
    }
    // Settlement can establish commit even when the ordinary reply is lost.
    // Join its history and publication before returning the transport failure.
    try {
      if (committed) {
        source.assertCurrent();
        for (const log of committed.logs) {
          state.deps.log[log.level](log.fields, log.message);
        }
        if (committed.job) {
          if (change.kind === "failure") {
            await emitCronRunFinished(
              state,
              {
                jobId,
                action: "finished",
                job: committed.job,
                status: "error",
                error: change.error,
                runAtMs: committed.nowMs,
                durationMs: 0,
                failureNotificationDelivery: failureNotificationDeliveryFromJobState(committed.job),
              },
              undefined,
              undefined,
              { historySource: source },
            );
            source.assertCurrent();
          }
          applyCronRuntimeRowsToState(state, [committed.job]);
          if (change.kind === "retire") {
            retiredIdentity = committed.job.state.streamSourceIdentity;
          }
        }
        if (change.kind === "failure") {
          for (const notification of committed.notifications) {
            source.assertCurrent();
            runPostPersistCronNotifications(state, [notification]);
          }
          source.assertCurrent();
          armTimer(state);
        }
      }
    } catch (error) {
      if (!failure) {
        throw error;
      }
      state.deps.log.warn({ jobId, error }, "cron: committed external state publication failed");
    }
    if (failure) {
      if (change.kind === "retire" && retiredIdentity !== undefined) {
        throw new CronStreamSourceRetirementError(
          {
            jobId,
            scheduleKey: change.source.scheduleKey,
            previousIdentity: change.source.identity,
            identity: retiredIdentity,
          },
          failure.error,
        );
      }
      throw failure.error;
    }
    return committed?.job;
  });
}

export async function recordExternalFailure(
  state: CronServiceState,
  id: string,
  error: string,
  statePatch: Partial<CronJob["state"]>,
  source?: { scheduleKey: string; identity: string },
): Promise<void> {
  await mutateExternalState(state, id, { kind: "failure", error, statePatch, source });
}

/** Source-qualified state cannot overwrite the identity of its replacement. */
export async function updateExternalState(
  state: CronServiceState,
  id: string,
  scheduleKey: string,
  identity: string,
  statePatch: Partial<CronJob["state"]>,
): Promise<boolean> {
  return (
    (await mutateExternalState(state, id, {
      kind: "state",
      source: { scheduleKey, identity },
      statePatch,
    })) !== undefined
  );
}

export async function retireExternalStreamSource(
  state: CronServiceState,
  id: string,
  scheduleKey: string,
  identity: string,
): Promise<string | undefined> {
  const job = await mutateExternalState(state, id, {
    kind: "retire",
    source: { scheduleKey, identity },
    nextIdentity: createCronStreamSourceIdentity(),
  });
  return job?.state.streamSourceIdentity;
}

/** Loss counters remain monotonic across logical source replacement. */
export async function updateExternalCounters(
  state: CronServiceState,
  id: string,
  counters: Pick<CronJob["state"], "streamDroppedBatches" | "streamCoalescedBatches">,
): Promise<void> {
  await mutateExternalState(state, id, { kind: "counters", counters });
}
