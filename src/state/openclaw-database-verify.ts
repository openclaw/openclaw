import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawDatabaseVerifyTarget } from "./openclaw-database-verify.worker.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/database-verify");
type QuickCheckQueue = {
  paths: Set<string>;
  subscribers: Set<() => void>;
  active?: object;
};
const quickCheckQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseIntegrityQuickChecks"),
  () => new Map<string, QuickCheckQueue>(),
);

function quickCheckQueue(env: NodeJS.ProcessEnv): QuickCheckQueue {
  const key = path.resolve(resolveOpenClawStateSqlitePath(env));
  let queue = quickCheckQueues.get(key);
  if (!queue) {
    queue = { paths: new Set(), subscribers: new Set() };
    quickCheckQueues.set(key, queue);
  }
  return queue;
}

function wakeSubscribers(queue: QuickCheckQueue): void {
  for (const wake of queue.subscribers) {
    wake();
  }
}

/** Cached opens queue work; only the listening Gateway starts the verifier. */
export function requestOpenClawAgentDatabaseQuickCheck(options: {
  path: string;
  env: NodeJS.ProcessEnv;
}): void {
  const queue = quickCheckQueue(options.env);
  queue.paths.add(path.resolve(options.path));
  wakeSubscribers(queue);
}

/** Consume requested agent quick checks for the listening Gateway. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  stop: () => Promise<void>;
} {
  const env = { ...options.env };
  const queue = quickCheckQueue(env);
  const owner = {};
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let activeWorker: ChildProcess | undefined;
  let activeRun: Promise<void> | undefined;
  let claimedQuickPaths: string[] = [];
  let stopPromise: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
    const quickPaths = [...queue.paths];
    claimedQuickPaths = quickPaths;
    queue.paths.clear();
    try {
      const { applyOpenClawDatabaseVerificationResults, runDatabaseVerifyWorker } =
        await import("./openclaw-database-verify.impl.js");
      if (stopped) {
        return;
      }
      const targets: OpenClawDatabaseVerifyTarget[] = quickPaths.map((pathname) => ({
        kind: "agent",
        label: "OpenClaw agent database",
        path: pathname,
        check: "quick",
      }));
      const results = await runDatabaseVerifyWorker(targets, {
        onWorker: (worker) => {
          activeWorker = worker;
        },
      });
      if (!stopped) {
        await applyOpenClawDatabaseVerificationResults({ env, results, targets });
      }
    } catch (error) {
      if (!stopped) {
        log.error("database integrity verifier failed", { error: String(error) });
      }
    } finally {
      activeWorker = undefined;
      claimedQuickPaths = [];
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
        for (const pathname of claimedQuickPaths) {
          queue.paths.add(pathname);
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
