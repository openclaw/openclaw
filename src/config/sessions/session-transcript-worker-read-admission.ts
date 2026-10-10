import { hasSqliteDatabaseSchemaAdmissionForPath } from "../../infra/sqlite-database-admission.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
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
  },
  run: (admit: ReadAdmission, lane: SessionHistoryWorkerLane) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + request.timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new WorkerTaskError("worker task timed out", "timeout");
    }
    return remaining;
  };
  let additionalLane: SessionHistoryWorkerLane | undefined;
  try {
    const cold = !request.knownSource && !hasSqliteDatabaseSchemaAdmissionForPath(options.path);
    const lane = cold ? targetDiscoveryLane : requestedLane;
    if (lane !== requestedLane) {
      historyClearTimeout(lane.idleTimer);
      lane.pending++;
      additionalLane = lane;
      refreshDatabaseWorkerPressureSubscription();
    }
    const admit: ReadAdmission = async (dispatch) => {
      const start = (signal: AbortSignal | undefined) => {
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
      return cold ? dispatchCold() : start(request.signal);
    };
    return await run(admit, lane);
  } finally {
    if (additionalLane) {
      additionalLane.pending--;
      armDatabaseWorkerIdleRetirement(additionalLane);
    }
  }
}
