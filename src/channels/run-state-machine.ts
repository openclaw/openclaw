// Channel run-state tracker used to publish busy/activity status.
type RunStateStatusPatch = {
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  activeRunStartedAt?: number | null;
};

/** Status sink used by channel run-state updates. */
export type RunStateStatusSink = (patch: RunStateStatusPatch) => void;

type RunStateMachineParams = {
  setStatus?: RunStateStatusSink;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
};

const DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS = 60_000;

type RunHandle = number;

/** Creates a channel run-state tracker with heartbeat updates while runs are active. */
export function createRunStateMachine(params: RunStateMachineParams) {
  const heartbeatMs = params.heartbeatMs ?? DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS;
  const now = params.now ?? Date.now;
  const runStartsByHandle = new Map<RunHandle, number>();
  let nextRunHandle = 0;
  let runActivityHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lifecycleActive = !params.abortSignal?.aborted;

  const oldestActiveRunStart = (): number | null => {
    let oldest: number | null = null;
    for (const startedAt of runStartsByHandle.values()) {
      if (oldest == null || startedAt < oldest) {
        oldest = startedAt;
      }
    }
    return oldest;
  };

  const publish = () => {
    if (!lifecycleActive) {
      return;
    }
    const activeRuns = runStartsByHandle.size;
    params.setStatus?.({
      activeRuns,
      busy: activeRuns > 0,
      lastRunActivityAt: now(),
      activeRunStartedAt: oldestActiveRunStart(),
    });
  };

  const clearHeartbeat = () => {
    if (!runActivityHeartbeat) {
      return;
    }
    clearInterval(runActivityHeartbeat);
    runActivityHeartbeat = null;
  };

  const ensureHeartbeat = () => {
    if (runActivityHeartbeat || runStartsByHandle.size <= 0 || !lifecycleActive) {
      return;
    }
    runActivityHeartbeat = setInterval(() => {
      if (!lifecycleActive || runStartsByHandle.size <= 0) {
        clearHeartbeat();
        return;
      }
      publish();
    }, heartbeatMs);
    runActivityHeartbeat.unref?.();
  };

  const deactivate = () => {
    lifecycleActive = false;
    clearHeartbeat();
  };

  const onAbort = () => {
    deactivate();
  };

  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  if (lifecycleActive) {
    // Reset inherited status from previous process lifecycle.
    params.setStatus?.({
      activeRuns: 0,
      busy: false,
      activeRunStartedAt: null,
    });
  }

  return {
    isActive() {
      return lifecycleActive;
    },
    onRunStart(): RunHandle {
      const handle = nextRunHandle++;
      runStartsByHandle.set(handle, now());
      publish();
      ensureHeartbeat();
      return handle;
    },
    onRunEnd(handle?: RunHandle) {
      if (handle == null) {
        const oldestHandle = runStartsByHandle.keys().next().value;
        if (oldestHandle != null) {
          runStartsByHandle.delete(oldestHandle);
        }
      } else {
        runStartsByHandle.delete(handle);
      }
      if (runStartsByHandle.size <= 0) {
        clearHeartbeat();
      }
      publish();
    },
    deactivate,
  };
}
