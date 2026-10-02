import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type MatcherRuntime = {
  pool?: WorkerTaskPool<{ pattern: string; lines: string[] }, boolean>;
  closing?: Promise<void>;
};

export function matchCronStreamLines(
  pattern: string,
  lines: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const state = resolveGlobalSingleton<MatcherRuntime>(
    Symbol.for("openclaw.cronStreamMatcher"),
    () => ({}),
    (runtime) => {
      runtime.closing ??= (async () => {
        await runtime.pool?.close();
        runtime.pool = undefined;
      })().finally(() => {
        runtime.closing = undefined;
      });
      return runtime.closing;
    },
  );
  if (state.closing) {
    return Promise.reject(new WorkerTaskError("cron stream matcher is closing", "unavailable"));
  }
  const pool = (state.pool ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeProcessEntrypointUrl("cronStreamMatcher"),
    maxWorkers: 2,
    sharedCompute: true,
    maxPendingTasks: 32,
    maxPendingBytes: 8 * 1024 * 1024,
  }));
  return pool.run(
    { pattern, lines },
    {
      signal,
      timeoutMs: 3_000,
      inputBytes: lines.reduce((bytes, line) => bytes + 2 * line.length + 8, 2 * pattern.length),
    },
  );
}
