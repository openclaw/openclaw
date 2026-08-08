/** Result of isolating a channel plugin hook behind a host-owned deadline. */
type ChannelHookTimeoutResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout"; started?: boolean };

// Timed-out plugin work is not cancellable. Keep it charged to its channel until
// it really settles so later health requests cannot exceed the advertised cap.
const activeChannelHookTasks = new Map<string, Set<Promise<unknown>>>();

function createChannelHookRun<T>(params: {
  capacityKey?: string;
  run: () => Promise<T> | T;
}): Promise<ChannelHookTimeoutResult<T>> {
  const run = Promise.resolve()
    .then(params.run)
    .then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  if (!params.capacityKey) {
    return run;
  }
  const capacityKey = params.capacityKey;
  const active = activeChannelHookTasks.get(capacityKey) ?? new Set<Promise<unknown>>();
  activeChannelHookTasks.set(capacityKey, active);
  active.add(run);
  void run.then(() => {
    active.delete(run);
    if (active.size === 0) {
      activeChannelHookTasks.delete(capacityKey);
    }
  });
  return run;
}

async function waitForChannelHookResult<T>(params: {
  timeoutMs: number;
  run: Promise<ChannelHookTimeoutResult<T>>;
}): Promise<ChannelHookTimeoutResult<T>> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
  const result = await Promise.race([params.run, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

/** Bounds channel plugin work even when an adapter ignores its timeout hint. */
export async function raceChannelHookWithTimeout<T>(params: {
  timeoutMs: number;
  run: () => Promise<T> | T;
}): Promise<ChannelHookTimeoutResult<T>> {
  return await waitForChannelHookResult({
    timeoutMs: params.timeoutMs,
    run: createChannelHookRun({ run: params.run }),
  });
}

/** Runs account pipelines with a hard deadline while retaining timed-out capacity. */
export async function runChannelHookTasksWithTimeout<T>(params: {
  capacityKey: string;
  limit: number;
  timeoutMs: number;
  tasks: Array<() => Promise<T> | T>;
}): Promise<Array<ChannelHookTimeoutResult<T>>> {
  const results: Array<ChannelHookTimeoutResult<T>> = Array.from({ length: params.tasks.length });
  if (params.tasks.length === 0) {
    return results;
  }

  const active = activeChannelHookTasks.get(params.capacityKey);
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 1;
  const available = Math.max(0, limit - (active?.size ?? 0));
  const queue = params.tasks.map((run, index) => ({ index, run }));
  const workers = Array.from({ length: Math.min(available, params.tasks.length) }, async () => {
    while (true) {
      const task = queue.shift();
      if (!task) {
        return;
      }
      const result = await waitForChannelHookResult({
        timeoutMs: params.timeoutMs,
        run: createChannelHookRun({
          capacityKey: params.capacityKey,
          run: task.run,
        }),
      });
      results[task.index] = result.kind === "timeout" ? { ...result, started: true } : result;
      if (result.kind === "timeout") {
        return;
      }
    }
  });
  await Promise.all(workers);
  for (const task of queue) {
    results[task.index] = { kind: "timeout", started: false };
  }
  return results;
}
