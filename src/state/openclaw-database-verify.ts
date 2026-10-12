import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasRevokedOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
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
  wake?: () => void;
  releases: Set<Promise<void>>;
  active?: boolean;
};
const integrityCheckQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseIntegrityChecks"),
  () => new Map<string, IntegrityCheckQueue>(),
);

function integrityCheckQueue(env: NodeJS.ProcessEnv): IntegrityCheckQueue {
  const key = path.resolve(resolveOpenClawStateSqlitePath(env));
  let queue = integrityCheckQueues.get(key);
  if (!queue) {
    queue = { paths: new Map(), releases: new Set() };
    integrityCheckQueues.set(key, queue);
  }
  return queue;
}

/** Deferral belongs to a running verifier, never a queue without a consumer. */
export function captureOpenClawDatabaseIntegrityVerifier(database: {
  databasePath: string;
  environment: NodeJS.ProcessEnv;
}): (() => void) | undefined {
  if (hasRevokedOpenClawAgentDatabaseValidation(database.databasePath)) {
    return undefined;
  }
  const queue = integrityCheckQueues.get(
    path.resolve(resolveOpenClawStateSqlitePath(database.environment)),
  );
  const owner = queue?.wake;
  return owner && queue
    ? () => {
        if (queue.wake !== owner) {
          throw new Error("Agent admission lost its background integrity verifier");
        }
      }
    : undefined;
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
  queue.wake?.();
}

/** Consume requested agent checks for the listening Gateway. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  stop: () => Promise<void>;
} {
  const env = { ...options.env };
  const queue = integrityCheckQueue(env);
  // One Gateway owns this queue; overlapping verifier instances are unsupported.
  if (queue.wake) {
    throw new Error("A database integrity verifier is already running for this state directory");
  }
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let activeWorker: ChildProcess | undefined;
  let activeRun: Promise<void> | undefined;
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
      queue.active = true;
      activeRun = inOwnerContext(run).finally(() => {
        activeRun = undefined;
        queue.active = false;
        queue.wake?.();
      });
    }, 0);
    timer.unref?.();
  };
  const run = async () => {
    const checks = new Map(queue.paths);
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
      for (const check of checks.values()) {
        releaseCheck(queue, check);
      }
      await Promise.all(queue.releases);
    }
  };

  // Publishers must not lend their request context to the Gateway verifier.
  const wake = () => inOwnerContext(schedule);
  queue.wake = wake;
  wake();
  return {
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      controller.abort(new Error("database integrity verifier stopped"));
      queue.wake = undefined;
      for (const check of queue.paths.values()) {
        releaseCheck(queue, check);
      }
      queue.paths.clear();
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
