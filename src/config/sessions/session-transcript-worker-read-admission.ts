import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { getAgentDeletionDatabaseCleanup } from "../../state/agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureExistingOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import {
  armDatabaseWorkerIdleRetirement,
  historyClearTimeout,
  refreshDatabaseWorkerPressureSubscription,
  targetDiscoveryLane,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";

type ReadAdmission = <T>(
  dispatch: (signal: AbortSignal | undefined, remainingMs: number) => Promise<T>,
) => Promise<T>;

/** Retain schema admission through reply processing without locking the consumer. */
export async function withSessionHistoryReadAdmission<T>(
  {
    lane: requestedLane,
    ...options
  }: OpenClawAgentDatabaseOptions & {
    path: string;
    lane: SessionHistoryWorkerLane;
  },
  request: {
    knownSource: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    aborters: Set<() => void>;
    assertCurrent: () => void;
  },
  run: (admit: ReadAdmission, lane: SessionHistoryWorkerLane) => Promise<T>,
): Promise<T> {
  request.assertCurrent();
  const deadline = performance.now() + request.timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new WorkerTaskError("worker task timed out", "timeout");
    }
    return remaining;
  };
  let execution: OpenClawAgentDatabaseExecution | undefined;
  let native: ReturnType<typeof retainOpenClawAgentDatabaseReadCandidates> | undefined;
  let additionalLane: SessionHistoryWorkerLane | undefined;
  let outcome: { value: T } | { error: unknown };
  try {
    if (!request.knownSource) {
      const cleanup = getAgentDeletionDatabaseCleanup(options);
      if (cleanup?.worker) {
        // Worker cleanup retains its executor and checks durable authority in its grants.
        cleanup.assertCurrentHost();
      } else {
        native = retainOpenClawAgentDatabaseReadCandidates(
          [{ path: options.path }],
          options.env ?? process.env,
        );
      }
      if (!native?.databases.length) {
        execution = captureExistingOpenClawAgentDatabaseExecution(options);
      }
    }
    const prepared = execution?.capturePreparedGenerationClaim();
    const cold = !request.knownSource && !native?.databases.length && !prepared;
    const lane = cold ? targetDiscoveryLane : requestedLane;
    if (lane !== requestedLane) {
      historyClearTimeout(lane.idleTimer);
      lane.pending++;
      additionalLane = lane;
      refreshDatabaseWorkerPressureSubscription();
    }
    const admit: ReadAdmission = async (dispatch) => {
      const start = (signal: AbortSignal | undefined) => {
        request.assertCurrent();
        prepared?.assertCurrent();
        return dispatch(signal, remainingTime());
      };
      const dispatchCold = async () => {
        const controller = new AbortController();
        const signal = request.signal
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal;
        const abort = () =>
          controller.abort(
            new WorkerTaskError("Session history database read was revoked", "unavailable"),
          );
        request.aborters.add(abort);
        const timer = setTimeout(
          () => controller.abort(new WorkerTaskError("worker task timed out", "timeout")),
          Math.max(1, deadline - performance.now()),
        );
        timer.unref?.();
        try {
          return await runOpenClawAgentWriteAdmission(
            options,
            () => {
              // The pool owns dispatch and host-response budgets after admission.
              clearTimeout(timer);
              return start(signal);
            },
            true,
            undefined,
            signal,
          );
        } finally {
          clearTimeout(timer);
          request.aborters.delete(abort);
        }
      };
      // Cold reads and first creation share admission, so no reader opens a
      // half-created schema. Release the reservation before consumer effects.
      const reply = await (cold ? dispatchCold() : start(request.signal));
      request.assertCurrent();
      prepared?.assertCurrent();
      return reply;
    };
    outcome = { value: await run(admit, lane) };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailure: { error: unknown } | undefined;
  try {
    native?.release();
    await execution?.release();
  } catch (error) {
    cleanupFailure = { error };
  }
  try {
    if (additionalLane) {
      additionalLane.pending--;
      armDatabaseWorkerIdleRetirement(additionalLane);
    }
  } catch (error) {
    cleanupFailure = {
      error: cleanupFailure
        ? sessionHistoryCleanupError(cleanupFailure.error, error, "worker retirement")
        : error,
    };
  }
  if (cleanupFailure) {
    throw "error" in outcome
      ? sessionHistoryCleanupError(outcome.error, cleanupFailure.error, "worker retirement")
      : cleanupFailure.error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
