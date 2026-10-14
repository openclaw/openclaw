import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import type { ProcessScopeCleanupPolicy } from "../process/supervisor/types.js";

type Deferred = {
  resolve: (exit: { exitCode: number | null; reason: string }) => void;
  reject: (err: unknown) => void;
};

/**
 * Minimal fake ProcessSupervisor: each spawn returns a run whose wait() is
 * controlled by the test, so we can deterministically drive "command exited".
 */
export function makeFakeSupervisor(
  opts: { deferSpawn?: boolean; cleanup?: () => Promise<void> } = {},
) {
  const runs: {
    scopeKey?: string;
    runId: string;
    deferred: Deferred;
    waitPromise: Promise<unknown>;
    cancelled: boolean;
  }[] = [];
  const cancelledScopes: string[] = [];
  const runCancels: string[] = [];
  let counter = 0;
  let releaseSpawn: (() => void) | undefined;
  const spawnGate = opts.deferSpawn
    ? new Promise<void>((res) => {
        releaseSpawn = res;
      })
    : Promise.resolve();
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
      await spawnGate;
      counter += 1;
      const runId = `run-${counter}`;
      const {
        promise: waitPromise,
        resolve: resolveWait,
        reject: rejectWait,
      } = createDeferred<{ exitCode: number | null; reason: string }>();
      // Pre-attach a no-op catch so a test-driven rejection never escapes as an
      // unhandled rejection if the run loses ownership before it awaits wait().
      waitPromise.catch(() => {});
      const entry = {
        scopeKey: input.scopeKey,
        runId,
        deferred: { resolve: resolveWait, reject: rejectWait },
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
    releaseSpawn: () => releaseSpawn?.(),
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
