import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawDatabaseVerifyTarget } from "./openclaw-database-verify.worker.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/database-verify");
type IntegrityCheck = OpenClawDatabaseVerifyTarget["check"];
type IntegrityCheckQueue = {
  paths: Map<string, IntegrityCheck>;
  subscribers: Set<() => void>;
  active?: object;
};
const integrityCheckQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseIntegrityChecks"),
  () => new Map<string, IntegrityCheckQueue>(),
);

function integrityCheckQueue(env: NodeJS.ProcessEnv): IntegrityCheckQueue {
  const key = path.resolve(resolveOpenClawStateSqlitePath(env));
  let queue = integrityCheckQueues.get(key);
  if (!queue) {
    queue = { paths: new Map(), subscribers: new Set() };
    integrityCheckQueues.set(key, queue);
  }
  return queue;
}

function wakeSubscribers(queue: IntegrityCheckQueue): void {
  for (const wake of queue.subscribers) {
    wake();
  }
}

function enqueueCheck(queue: IntegrityCheckQueue, pathname: string, check: IntegrityCheck): void {
  queue.paths.set(pathname, queue.paths.get(pathname) === "full" ? "full" : check);
}

/** Admitted opens queue work; only the listening Gateway starts the verifier. */
export function requestOpenClawAgentDatabaseIntegrityCheck(options: {
  path: string;
  env: NodeJS.ProcessEnv;
  check: IntegrityCheck;
}): void {
  const queue = integrityCheckQueue(options.env);
  enqueueCheck(queue, path.resolve(options.path), options.check);
  wakeSubscribers(queue);
}

/** Consume requested agent checks for the listening Gateway. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  stop: () => Promise<void>;
} {
  const env = { ...options.env };
  const queue = integrityCheckQueue(env);
  const owner = {};
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let activeWorker: ChildProcess | undefined;
  let activeRun: Promise<void> | undefined;
  let claimedChecks: Array<[string, IntegrityCheck]> = [];
  let stopPromise: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const workerLifetime = {
    onWorker: (worker: ChildProcess | undefined) => {
      activeWorker = worker;
    },
    assertCurrent: () => {
      if (stopped) {
        throw new Error("database integrity verifier stopped");
      }
    },
  };

  const schedule = () => {
    if (stopped || queue.active || queue.paths.size === 0) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || queue.active || queue.paths.size === 0) {
        return;
      }
      queue.active = owner;
      activeRun = inOwnerContext(run).finally(() => {
        activeRun = undefined;
        queue.active = undefined;
        wakeSubscribers(queue);
      });
    }, 0);
    timer.unref?.();
  };
  const run = async () => {
    const checks = [...queue.paths];
    claimedChecks = checks;
    queue.paths.clear();
    try {
      const { applyOpenClawDatabaseVerificationResults, runDatabaseVerifyWorker } =
        await import("./openclaw-database-verify.impl.js");
      if (stopped) {
        return;
      }
      const targets: OpenClawDatabaseVerifyTarget[] = checks.map(([pathname, check]) => ({
        kind: "agent",
        label: "OpenClaw agent database",
        path: pathname,
        check,
      }));
      const results = await runDatabaseVerifyWorker(targets, workerLifetime);
      if (!stopped) {
        await applyOpenClawDatabaseVerificationResults({ env, results, targets, workerLifetime });
      }
    } catch (error) {
      if (!stopped) {
        log.error("database integrity verifier failed", { error: String(error) });
      }
    } finally {
      activeWorker = undefined;
      claimedChecks = [];
    }
  };

  // Publishers and retiring peers must not lend their request or Gateway context.
  const wake = () => inOwnerContext(schedule);
  queue.subscribers.add(wake);
  wake();
  return {
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      queue.subscribers.delete(wake);
      if (queue.subscribers.size === 0) {
        queue.paths.clear();
      } else {
        // Replay before yielding so a later final stop can still discard this work.
        for (const [pathname, check] of claimedChecks) {
          enqueueCheck(queue, pathname, check);
        }
        wakeSubscribers(queue);
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      stopPromise = (async () => {
        try {
          const worker = activeWorker;
          if (worker) {
            const { terminateDatabaseVerifyWorker } =
              await import("./openclaw-database-verify.impl.js");
            await terminateDatabaseVerifyWorker(worker);
          }
        } finally {
          // Worker exit can precede async confirmation and result application.
          await activeRun;
        }
      })();
      return stopPromise;
    },
  };
}
