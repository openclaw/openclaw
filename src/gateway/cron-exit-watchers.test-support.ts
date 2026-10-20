import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import type { ProcessScopeCleanupPolicy } from "../process/supervisor/types.js";

type Exit = { exitCode: number | null; reason: string };

/** Each run's deferred controls command exit independently of spawn admission. */
export function makeFakeSupervisor(
  opts: { deferSpawn?: boolean; cleanup?: () => Promise<void> } = {},
) {
  const runs: {
    scopeKey?: string;
    runId: string;
    deferred: ReturnType<typeof createDeferred<Exit>>;
    waitPromise: Promise<unknown>;
    cancelled: boolean;
  }[] = [];
  const cancelledScopes: string[] = [];
  const runCancels: string[] = [];
  let counter = 0;
  const spawnGate = createDeferred<void>();
  if (!opts.deferSpawn) {
    spawnGate.resolve();
  }
  const supervisor = {
    acquireScopeCleanup: vi.fn(
      (scopeKey: string, _options: { processTree: ProcessScopeCleanupPolicy }) => {
        let closing: Promise<void> | undefined;
        return () => {
          if (!closing) {
            closing = opts.cleanup
              ? opts.cleanup()
              : Promise.allSettled(
                  runs.filter((run) => run.scopeKey === scopeKey).map((run) => run.waitPromise),
                ).then(() => undefined);
          }
          return closing;
        };
      },
    ),
    spawn: vi.fn(async (input: { scopeKey?: string }) => {
      await spawnGate.promise;
      const runId = `run-${++counter}`;
      const deferred = createDeferred<Exit>();
      const waitPromise = deferred.promise;
      // Ownership may be lost before wait(); keep controlled rejection handled.
      waitPromise.catch(() => {});
      const entry = {
        scopeKey: input.scopeKey,
        runId,
        deferred,
        waitPromise,
        cancelled: false,
      };
      runs.push(entry);
      return {
        runId,
        startedAtMs: 0,
        wait: () =>
          waitPromise.then((e) => ({
            ...e,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          })),
        cancel: () => {
          entry.cancelled = true;
          runCancels.push(runId);
        },
      };
    }),
    cancelScope: vi.fn((scopeKey: string) => {
      cancelledScopes.push(scopeKey);
    }),
  };
  return {
    supervisor,
    runs,
    cancelled: cancelledScopes,
    cancelledScopes,
    runCancels,
    releaseSpawn: () => spawnGate.resolve(),
  };
}

export function onExitJob(id: string, command = "true", enabled = true, cwd?: string): CronJob {
  return {
    id,
    agentId: "main",
    name: id,
    enabled,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "on-exit", command, ...(cwd ? { cwd } : {}) },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "done" },
    delivery: { mode: "none" },
    state: {},
  };
}
