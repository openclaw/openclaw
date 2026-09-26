import type { InternalGetReplyOptions } from "../get-reply.types.js";
import { resolveFollowupDeliveryContextKey } from "./delivery-context.js";
import {
  clearRestoredPendingDrainKey,
  resolveRestoredFollowupQueueRecoveryKey,
} from "./persist.js";
import type { FollowupRun } from "./types.js";

/**
 * Restored user follow-ups must not inherit heartbeat-only execution policy
 * from the recovery wake. Keep this object narrow: no heartbeat tools,
 * timeout override, lightweight bootstrap, or wake abort signal.
 */
export function createRestoredFollowupDrainOpts(): InternalGetReplyOptions {
  return { isHeartbeat: false };
}

/**
 * When a heartbeat (or other synthetic wake) reaches agent-runner after a
 * gateway restart, register a drain callback for the original restored queue
 * key and idle-kick it. Isolated heartbeats use `<base>:heartbeat` while the
 * durable queue stays keyed by `<base>`.
 *
 * Returns the restored queue key when recovery drain was scheduled.
 */
export function tryScheduleRestoredFollowupQueueDrain<
  TOperation extends { sessionId: string },
>(params: {
  candidates: Array<string | undefined | null>;
  createRunFollowup: (restoredQueueKey: string) => (run: FollowupRun) => Promise<void>;
  getActiveReplyOperation: (key: string) => TOperation | undefined;
  scheduleAfterClear: (args: {
    operation: TOperation;
    queueKey: string;
    runFollowup: (run: FollowupRun) => Promise<void>;
  }) => void;
  scheduleNow: (queueKey: string, runFollowup: (run: FollowupRun) => Promise<void>) => void;
}): string | undefined {
  const restoredQueueKey = resolveRestoredFollowupQueueRecoveryKey(params.candidates);
  if (!restoredQueueKey) {
    return undefined;
  }
  const runFollowup = params.createRunFollowup(restoredQueueKey);
  const activeReplyOperation = params.getActiveReplyOperation(restoredQueueKey);
  if (activeReplyOperation) {
    params.scheduleAfterClear({
      operation: activeReplyOperation,
      queueKey: restoredQueueKey,
      runFollowup,
    });
  } else {
    params.scheduleNow(restoredQueueKey, runFollowup);
  }
  clearRestoredPendingDrainKey(restoredQueueKey);
  return restoredQueueKey;
}

/**
 * Build the restored-queue runner and claim the drain in one step.
 *
 * The caller holds the per-run arguments a follow-up runner needs; only the
 * policy that a restored drain runs as a non-heartbeat turn against the
 * restored key belongs here, next to the opts that encode it.
 */
export function claimRestoredHeartbeatFollowupDrain<
  TOperation extends { sessionId: string },
  TRunnerArgs extends object,
>(params: {
  candidates: Array<string | undefined | null>;
  runnerArgs: TRunnerArgs;
  createFollowupRunner: (
    args: TRunnerArgs & { opts: InternalGetReplyOptions; sessionKey: string },
  ) => (run: FollowupRun) => Promise<void>;
  getActiveReplyOperation: (key: string) => TOperation | undefined;
  scheduleAfterClear: Parameters<
    typeof tryScheduleRestoredFollowupQueueDrain<TOperation>
  >[0]["scheduleAfterClear"];
  scheduleNow: (queueKey: string, runFollowup: (run: FollowupRun) => Promise<void>) => void;
}): string | undefined {
  return tryScheduleRestoredFollowupQueueDrain({
    candidates: params.candidates,
    createRunFollowup: (restoredQueueKey) =>
      params.createFollowupRunner({
        ...params.runnerArgs,
        opts: createRestoredFollowupDrainOpts(),
        sessionKey: restoredQueueKey,
      }),
    getActiveReplyOperation: params.getActiveReplyOperation,
    scheduleAfterClear: params.scheduleAfterClear,
    scheduleNow: params.scheduleNow,
  });
}

/**
 * Repair a restored elision's delivery context.
 *
 * `contextKey` is runtime grouping and is deliberately not persisted, so a
 * restored elision arrives without one. Recover it from the first source rather
 * than letting the group fall back to an empty key and merge unrelated routes.
 */
export function restoreElisionDeliveryContext(entry: {
  contextKey: string;
  sources: readonly FollowupRun[];
}): void {
  if (entry.contextKey) {
    return;
  }
  const restoredSource = entry.sources[0];
  if (restoredSource) {
    entry.contextKey = resolveFollowupDeliveryContextKey(restoredSource);
  }
}
