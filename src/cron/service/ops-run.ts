import { randomUUID } from "node:crypto";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { retainGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createAbortError, isAbortError } from "../../infra/abort-signal.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { locked } from "./locked.js";
import { waitForRunSettlement } from "./ops-lifecycle.js";
import { inspectManualRunPreflight } from "./ops-run-preparation.js";
import type { ManualRunOptions, OnExitRunOptions } from "./run-options.js";
import { commitCronRunRequests, drainCronRunQueue, type RequestedCronRun } from "./run-queue.js";
import type { CronRunMode, CronRunResult, CronServiceState, CronWakeMode } from "./state.js";
import { captureCronServiceMutationSource } from "./store.js";
import { wake } from "./wake.js";

async function requestManualCronRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  options: ManualRunOptions = {},
): Promise<{ requested: RequestedCronRun } | CronRunResult> {
  const tracking = { ...options, terminalTracker: options.terminalTracker ?? { emitted: false } };
  const result = await locked(state, async () => {
    const source = captureCronServiceMutationSource(state);
    const preflight = await inspectManualRunPreflight(state, id, source, mode, tracking);
    if (!preflight.ok || "reason" in preflight) {
      return preflight;
    }
    const [requested] = await commitCronRunRequests(state, [preflight.job], {
      ...tracking,
      mode,
      source: "manual",
    });
    return requested
      ? { requested }
      : ({
          ok: true,
          ran: false,
          reason: tracking.terminalTracker.emitted ? "ownerless" : "already-running",
        } as const);
  });
  await drainCronRunQueue(state);
  return result;
}

export async function run(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
) {
  const execute = async () => {
    const result = await requestManualCronRun(state, id, mode, opts);
    return "requested" in result ? result.requested.completion : result;
  };
  return state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(execute) : execute();
}

/** Consuming an exit and queuing its payload share the receipt commit. */
export async function runOnExit(state: CronServiceState, id: string, opts: OnExitRunOptions) {
  const generation = state.lifecycleGeneration;
  const execute = async () => {
    const commitGuard = () => {
      if (opts.signal.aborted || state.stopped || generation !== state.lifecycleGeneration) {
        throw createAbortError("cron on-exit admission cancelled");
      }
      opts.commitGuard();
    };
    try {
      while (await waitForRunSettlement(state, id, opts.signal)) {
        const result = await requestManualCronRun(state, id, "force", {
          onExit: { ...opts, commitGuard },
          commitGuard,
        });
        if ("requested" in result) {
          return await result.requested.completion;
        }
        if (!(result.ok && "reason" in result && result.reason === "already-running")) {
          return result;
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    }
    return { ok: true, ran: false, reason: "stopped" } as const;
  };
  return state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(execute) : execute();
}

/** Acknowledgement follows the durable request; the execution belongs to cron. */
export async function enqueueRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: { commitGuard?: () => void },
) {
  const runId = `cron-request.${randomUUID()}`;
  const releaseCaller = retainGatewayDeviceRevocation(opts?.commitGuard);
  return runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayIndependentRootWorkContinuation(async () => {
      const result = await requestManualCronRun(state, id, mode, {
        ...opts,
        runId,
        scheduleOwnershipAtMs: state.deps.nowMs(),
        terminalTracker: { emitted: false },
      });
      if (!("requested" in result)) {
        releaseCaller?.();
        return result;
      }
      const completion = result.requested.completion
        .catch((error: unknown) => {
          state.deps.log.error(
            { jobId: id, runId, err: normalizeCronRunErrorText(error) },
            "cron: queued run failed",
          );
        })
        .finally(() => {
          releaseCaller?.();
          state.queuedManualRuns.delete(runId);
        });
      state.queuedManualRuns.set(runId, completion);
      return { ok: true, enqueued: true, runId } as const;
    }, "cron:manual-run"),
  ).catch((error: unknown) => {
    releaseCaller?.();
    throw error;
  });
}

/**
 * Resolves true once an accepted manual run has written its terminal history row,
 * or false when the timeout or caller signal ends the wait first.
 */
export async function waitForManualRun(
  state: CronServiceState,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const settled = state.queuedManualRuns.get(runId);
  if (!settled) {
    return true;
  }
  if (signal?.aborted) {
    return false;
  }
  const { promise, resolve } = createDeferredCore<boolean>();
  const timer = setSafeTimeout(() => resolve(false), timeoutMs);
  const onAbort = () => resolve(false);
  signal?.addEventListener("abort", onAbort, { once: true });
  // Background failures are logged by the run owner; the waiter only needs settlement.
  settled.then(
    () => resolve(true),
    () => resolve(true),
  );
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Enqueues manual wake text through the cron wake API. */
export function wakeNow(
  state: CronServiceState,
  opts: {
    mode: CronWakeMode;
    text: string;
    sessionKey?: string;
    agentId?: string;
    commitGuard?: () => void;
  },
) {
  return wake(state, opts);
}
