import { randomUUID } from "node:crypto";
import { calculateBackoff } from "./backoff.js";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";
import type {
  MinionHandler,
  MinionJob,
  MinionJobContext,
  MinionQueueOpts,
  MinionWorkerOpts,
  TokenUpdate,
} from "./types.js";
import { UnrecoverableError } from "./types.js";

interface InFlightJob {
  job: MinionJob;
  lockToken: string;
  lockTimer: ReturnType<typeof setInterval>;
  abort: AbortController;
  promise: Promise<void>;
}

export class MinionWorker {
  private queue: MinionQueue;
  private handlers = new Map<string, MinionHandler>();
  private sortedNames: string[] = [];
  private running = false;
  private inFlight = new Map<number, InFlightJob>();
  private workerId = randomUUID();
  private opts: Required<MinionWorkerOpts>;
  private readonly store: MinionStore;

  constructor(store: MinionStore, opts?: MinionWorkerOpts & Pick<MinionQueueOpts, "maxSpawnDepth">) {
    this.store = store;
    this.queue = new MinionQueue(store, {
      maxSpawnDepth: opts?.maxSpawnDepth,
    });
    this.opts = {
      queue: opts?.queue ?? "default",
      concurrency: opts?.concurrency ?? 1,
      lockDuration: opts?.lockDuration ?? 30000,
      stalledInterval: opts?.stalledInterval ?? 30000,
      maxStalledCount: opts?.maxStalledCount ?? 1,
      pollInterval: opts?.pollInterval ?? 5000,
      progressFlushInterval: opts?.progressFlushInterval ?? 250,
    };
  }

  register(name: string, handler: MinionHandler): void {
    this.handlers.set(name, handler);
    this.sortedNames = Array.from(this.handlers.keys()).toSorted();
  }

  get registeredNames(): string[] {
    return this.sortedNames;
  }

  async start(): Promise<void> {
    if (this.handlers.size === 0) {
      throw new Error(
        "No handlers registered. Call worker.register(name, handler) before start().",
      );
    }

    this.running = true;

    const shutdown = () => {
      this.running = false;
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    const stalledTimer = setInterval(() => {
      try {
        const { requeued, dead } = this.queue.handleStalled();
        if (requeued.length > 0 || dead.length > 0) {
          // structured log omitted for now; will be added with observability
        }
      } catch {
        // stall detection error; next tick will retry
      }
      try {
        this.queue.handleTimeouts();
      } catch {
        // timeout detection error; next tick
      }
    }, this.opts.stalledInterval);

    try {
      while (this.running) {
        try {
          this.queue.promoteDelayed();
        } catch {
          // promotion error; next tick
        }

        if (this.inFlight.size < this.opts.concurrency) {
          const lockToken = `${this.workerId}:${Date.now()}`;
          const job = this.queue.claim(
            lockToken,
            this.opts.lockDuration,
            this.opts.queue,
            this.sortedNames,
          );

          if (job) {
            this.launchJob(job, lockToken);
          } else if (this.inFlight.size === 0) {
            await sleep(this.opts.pollInterval);
          } else {
            await sleep(100);
          }
        } else {
          await sleep(100);
        }
      }
    } finally {
      clearInterval(stalledTimer);
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);

      if (this.inFlight.size > 0) {
        const pending = Array.from(this.inFlight.values()).map((f) => f.promise);
        await Promise.race([
          Promise.allSettled(pending),
          sleep(30000),
        ]);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private launchJob(job: MinionJob, lockToken: string): void {
    const abort = new AbortController();

    const lockTimer = setInterval(() => {
      const renewed = this.queue.renewLock(job.id, lockToken, this.opts.lockDuration);
      if (!renewed) {
        clearInterval(lockTimer);
        abort.abort();
      }
    }, this.opts.lockDuration / 2);

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (job.timeoutMs != null) {
      timeoutTimer = setTimeout(() => {
        if (!abort.signal.aborted) {
          abort.abort();
        }
      }, job.timeoutMs);
    }

    const promise = this.executeJob(job, lockToken, abort)
      .finally(() => {
        clearInterval(lockTimer);
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        this.inFlight.delete(job.id);
      });

    this.inFlight.set(job.id, { job, lockToken, lockTimer, abort, promise });
  }

  private async executeJob(
    job: MinionJob,
    lockToken: string,
    abort: AbortController,
  ): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.queue.failJob(
        job.id,
        lockToken,
        job.attemptsMade,
        `No handler for job type '${job.name}'`,
        "dead",
      );
      return;
    }

    this.queue.setHandlerPid(job.id, lockToken, process.pid);

    const context: MinionJobContext = {
      id: job.id,
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      signal: abort.signal,
      updateProgress: async (progress: unknown) => {
        this.queue.updateProgress(job.id, lockToken, progress);
      },
      updateTokens: async (tokens: TokenUpdate) => {
        this.queue.updateTokens(job.id, lockToken, tokens);
      },
      log: async (message) => {
        const value = typeof message === "string" ? message : JSON.stringify(message);
        const now = Date.now();
        const current = this.store.db
          .prepare("SELECT stacktrace FROM minion_jobs WHERE id = ? AND lock_token = ?")
          .get(job.id, lockToken) as { stacktrace: string | null } | undefined;
        if (!current) {
          return;
        }
        const trace: string[] = current.stacktrace
          ? (JSON.parse(current.stacktrace) as string[])
          : [];
        trace.push(value);
        this.store.db
          .prepare(
            "UPDATE minion_jobs SET stacktrace = ?, updated_at = ? WHERE id = ? AND lock_token = ?",
          )
          .run(JSON.stringify(trace), now, job.id, lockToken);
      },
      isActive: async () => {
        const rows = this.store.db
          .prepare(
            "SELECT id FROM minion_jobs WHERE id = ? AND status = 'active' AND lock_token = ?",
          )
          .all(job.id, lockToken);
        return rows.length > 0;
      },
      readInbox: async () => {
        return this.queue.readInbox(job.id, lockToken);
      },
    };

    try {
      const result = await handler(context);

      const completed = this.queue.completeJob(
        job.id,
        lockToken,
        job.attemptsMade,
        result != null
          ? typeof result === "object"
            ? (result as Record<string, unknown>)
            : { value: result }
          : undefined,
      );

      if (!completed) {
        return;
      }

      this.queue.clearHandlerPid(job.id);
    } catch (err) {
      if (abort.signal.aborted) {
        return;
      }

      const errorText = err instanceof Error ? err.message : String(err);
      const isUnrecoverable = err instanceof UnrecoverableError;
      const attemptsExhausted = job.attemptsMade + 1 >= job.maxAttempts;

      let newStatus: "delayed" | "failed" | "dead";
      if (isUnrecoverable || attemptsExhausted) {
        newStatus = "dead";
      } else {
        newStatus = "delayed";
      }

      const backoffMs =
        newStatus === "delayed"
          ? calculateBackoff({
              backoffType: job.backoffType,
              backoffDelay: job.backoffDelay,
              backoffJitter: job.backoffJitter,
              attemptsMade: job.attemptsMade + 1,
            })
          : 0;

      this.queue.failJob(
        job.id,
        lockToken,
        job.attemptsMade,
        errorText,
        newStatus,
        backoffMs,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
