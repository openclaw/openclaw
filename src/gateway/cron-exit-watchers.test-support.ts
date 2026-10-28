import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import type { ProcessScopeCleanupPolicy, RunExit } from "../process/supervisor/types.js";
import { runExit } from "./server-cron.process.test-support.js";

type Exit = Pick<RunExit, "exitCode" | "reason">;

export function makeFakeSupervisor(
  opts: { deferSpawn?: boolean; cleanup?: () => Promise<void> } = {},
) {
  const runs: {
    scopeKey?: string;
    runId: string;
    deferred: ReturnType<typeof createDeferred<Exit>>;
  }[] = [];
  const cancelled: string[] = [];
  const runCancels: string[] = [];
  const spawnGate = createDeferred();
  if (!opts.deferSpawn) {
    spawnGate.resolve();
  }
  const supervisor = {
    acquireScopeCleanup: vi.fn(
      (scopeKey: string, _options: { processTree: ProcessScopeCleanupPolicy }) => {
        let closing: Promise<void> | undefined;
        return () =>
          (closing ??= opts.cleanup
            ? opts.cleanup()
            : Promise.allSettled(
                runs.filter((run) => run.scopeKey === scopeKey).map((run) => run.deferred.promise),
              ).then(() => undefined));
      },
    ),
    spawn: vi.fn(async (input: { scopeKey?: string }) => {
      await spawnGate.promise;
      const runId = `run-${runs.length + 1}`;
      const deferred = createDeferred<Exit>();
      // Ownership may be lost before wait(); keep controlled rejection handled.
      deferred.promise.catch(() => {});
      runs.push({ scopeKey: input.scopeKey, runId, deferred });
      return {
        runId,
        startedAtMs: 0,
        wait: () => deferred.promise.then(runExit),
        cancel: () => {
          runCancels.push(runId);
        },
      };
    }),
    cancelScope: vi.fn((scopeKey: string) => {
      cancelled.push(scopeKey);
    }),
  };
  return {
    supervisor,
    runs,
    cancelled,
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
