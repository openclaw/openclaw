import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawDatabaseVerifyTarget } from "./openclaw-database-verify.worker.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/database-verify");
type IntegrityCheck = OpenClawDatabaseVerifyTarget["check"];
type IntegrityCheckRequest = {
  check: IntegrityCheck;
  proof?: {
    identity: string;
    complete: (assertCurrent: () => void, signal: AbortSignal) => Promise<boolean>;
  };
  release?: () => Promise<void>;
};
type IntegrityCheckQueue = {
  paths: Map<string, IntegrityCheckRequest>;
  subscribers: Set<() => void>;
  releases: Set<Promise<void>>;
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
    queue = { paths: new Map(), subscribers: new Set(), releases: new Set() };
    integrityCheckQueues.set(key, queue);
  }
  return queue;
}

function wakeSubscribers(queue: IntegrityCheckQueue): void {
  for (const wake of queue.subscribers) {
    wake();
  }
}

function enqueueCheck(
  queue: IntegrityCheckQueue,
  pathname: string,
  request: IntegrityCheckRequest,
): void {
  if (request.check === "full" || queue.paths.get(pathname)?.check !== "full") {
    const previous = queue.paths.get(pathname);
    queue.paths.set(pathname, request);
    if (previous) {
      releaseCheck(queue, previous);
    }
  } else {
    releaseCheck(queue, request);
  }
}

function releaseCheck(queue: IntegrityCheckQueue, request: IntegrityCheckRequest): void {
  const release = request.release;
  request.release = undefined;
  if (!release) {
    return;
  }
  const pending = release().catch((error: unknown) => {
    log.error("database integrity verification cleanup failed", { error: String(error) });
  });
  queue.releases.add(pending);
  void pending.finally(() => queue.releases.delete(pending));
}

/** Admitted opens queue work; only the listening Gateway starts the verifier. */
export function requestOpenClawAgentDatabaseIntegrityCheck(
  options: IntegrityCheckRequest & {
    path: string;
    env: NodeJS.ProcessEnv;
  },
): void {
  const queue = integrityCheckQueue(options.env);
  enqueueCheck(queue, path.resolve(options.path), {
    check: options.check,
    proof: options.proof,
    release: options.release,
  });
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
  let claimedChecks = new Map<string, IntegrityCheckRequest>();
  let stopPromise: Promise<void> | undefined;
  let stopped = false;
  const controller = new AbortController();
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
    const checks = new Map(queue.paths);
    claimedChecks = checks;
    queue.paths.clear();
    try {
      const { applyOpenClawDatabaseVerificationResults, runDatabaseVerifyWorker } =
        await import("./openclaw-database-verify.impl.js");
      if (stopped) {
        return;
      }
      const targets: OpenClawDatabaseVerifyTarget[] = Array.from(checks, ([pathname, request]) => ({
        kind: "agent",
        label: "OpenClaw agent database",
        path: pathname,
        check: request.check,
        ...(request.proof ? { identity: request.proof.identity } : {}),
      }));
      const results = await runDatabaseVerifyWorker(targets, workerLifetime);
      if (!stopped) {
        await applyOpenClawDatabaseVerificationResults({
          env,
          results,
          targets,
          workerLifetime,
          onVerified: async (pathname) => {
            const request = checks.get(pathname);
            if (request?.check === "full") {
              return request.proof?.complete(workerLifetime.assertCurrent, controller.signal);
            }
            return undefined;
          },
        });
      }
    } catch (error) {
      if (!stopped) {
        log.error("database integrity verifier failed", { error: String(error) });
      }
    } finally {
      activeWorker = undefined;
      for (const [pathname, check] of checks) {
        if (queue.paths.get(pathname) !== check) {
          releaseCheck(queue, check);
        }
      }
      claimedChecks.clear();
      await Promise.all(queue.releases);
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
      controller.abort(new Error("database integrity verifier stopped"));
      queue.subscribers.delete(wake);
      if (queue.subscribers.size === 0) {
        for (const check of queue.paths.values()) {
          releaseCheck(queue, check);
        }
        queue.paths.clear();
      } else {
        // Replay before yielding so a later final stop can still discard this work.
        for (const [pathname, check] of claimedChecks) {
          // A newer full request carries its own writer's publication authority.
          if (queue.paths.get(pathname)?.check !== "full") {
            enqueueCheck(queue, pathname, check);
          }
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
          await Promise.all(queue.releases);
        }
      })();
      return stopPromise;
    },
  };
}
