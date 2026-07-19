import { resolveCronTriggerMinIntervalMs } from "../config/cron-limits.js";
import type { CronRetryConfig } from "../config/types.cron.js";
import { errorBackoffMs } from "../cron/service/jobs.js";
import {
  cronStreamScheduleKey,
  resolveCronStreamBatching,
  truncateCronStreamBatch,
  type CronStreamSchedule,
} from "../cron/stream-schedule.js";
import type { CronJob, CronJobState } from "../cron/types.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../security/safe-regex.js";

const SCOPE_PREFIX = "cron-stream";
const STABLE_RUN_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const COUNTER_MAX = 2_147_483_647;
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const OWNER_STOP_TIMEOUT_MS = STOP_SETTLE_TIMEOUT_MS * 2;
const MAX_BUFFERED_OUTPUT_SEGMENTS = 64;
const MAX_TRACKED_STALE_GENERATIONS = 16;
const MAX_RETIRED_COUNTER_SEEDS = 1_024;
const MAX_MUTATION_EPOCHS = 1_024;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type StreamCronJob = CronJob & {
  schedule: CronStreamSchedule;
};

export type CronStreamFireDisposition =
  | "fired"
  | "disabled"
  | "dropped"
  | "busy"
  | "error"
  | "not-run";

type StreamOwnerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "backoff";

type StreamStopReason =
  | "disabled"
  | "removed"
  | "shutdown"
  | "schedule-update"
  | "trust-disabled"
  | "cron-disabled"
  | "restart-exhausted"
  | "trigger-disabled";

type StreamLossReason =
  | "gate-drop"
  | "coalesced"
  | "not-running"
  | "payload-error"
  | "stale-generation";

type StreamOutputChannel = "stdout" | "stderr";

type StreamOwnerSnapshot = {
  state: StreamOwnerState;
  generation: number;
  processAlive: boolean;
  restartTimerPending: boolean;
  bufferedOutputBytes: number;
  bufferedOutputSegments: number;
  droppedBatches: number;
  coalescedBatches: number;
  consecutiveFailures: number;
};

type CronStreamWatchers = {
  reconcile: (jobs: CronJob[], enabled: boolean, triggersEnabled?: boolean) => Promise<void>;
  resume: () => void;
  start: (job: CronJob) => Promise<void>;
  stop: (jobId: string, reason: StreamStopReason, job?: CronJob) => Promise<void>;
  stopAll: (reason: StreamStopReason) => Promise<void>;
  activeJobIds: () => string[];
  inspect: (jobId: string) => StreamOwnerSnapshot | undefined;
};

type OwnerParams = {
  getProcessSupervisor: () => ProcessSupervisor;
  minIntervalMs: number;
  retryBackoffMs?: number[];
  updateState: (
    jobId: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
  ) => Promise<boolean | void>;
  updateCounters?: (
    jobId: string,
    counters: Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">,
  ) => Promise<void>;
  recordFailure: (
    jobId: string,
    error: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
  ) => Promise<void>;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
  ) => Promise<CronStreamFireDisposition>;
  logger: Logger;
  nowMs: () => number;
};

type InFlightBatch = {
  batch: string;
  generation: number;
  startedAtMs: number;
  promise: Promise<CronStreamFireDisposition>;
  handled: boolean;
};

type BufferedOutput = {
  channel: StreamOutputChannel;
  chunk: string;
  generation: number;
};

function scopeKey(jobId: string): string {
  return `${SCOPE_PREFIX}:${jobId}`;
}

function boundedIncrement(value: number): number {
  return Math.min(COUNTER_MAX, Math.max(0, Math.floor(value)) + 1);
}

function isStreamJob(job: CronJob): job is StreamCronJob {
  return job.schedule.kind === "stream";
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function appendBatch(left: string | undefined, right: string, maxBytes: number): string {
  return left === undefined ? right : truncateCronStreamBatch(`${left}\n${right}`, maxBytes);
}

async function stopManagedRun(run: ManagedRun): Promise<void> {
  // Detach before terminating the process tree so pipe drains cannot enqueue
  // callbacks after the owner has entered stopping.
  run.detachOutput?.();
  run.cancel("manual-cancel");
  let timeout: NodeJS.Timeout | undefined;
  try {
    const exited = await Promise.race([
      run.wait().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), STOP_SETTLE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (!exited) {
      throw new Error(`stream source did not exit within ${STOP_SETTLE_TIMEOUT_MS}ms`);
    }
  } finally {
    clearTimer(timeout);
  }
}

async function waitForInFlightBatch(
  promise: Promise<CronStreamFireDisposition>,
): Promise<
  | { settled: true; disposition: CronStreamFireDisposition }
  | { settled: true; error: unknown }
  | { settled: false }
> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (disposition) => ({ settled: true as const, disposition }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ settled: false }), STOP_SETTLE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimer(timeout);
  }
}

class StreamJobOwner {
  private state: StreamOwnerState = "idle";
  private generation = 0;
  private desiredRunning = false;
  private retired = false;
  private removalRequested = false;
  // Live mirror of terminal restart-exhaustion; the constructor-time job.state
  // snapshot does not see an exhaustion that happens later, so a shutdown-time
  // read must consult this flag to preserve the diagnostic.
  private restartExhausted = false;
  private requestEpoch = 0;
  private opTail: Promise<void> = Promise.resolve();
  private job: StreamCronJob;
  private scheduleKey: string;
  private matcher?: RegExp;
  private run?: ManagedRun;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private quietTimer?: NodeJS.Timeout;
  private rateTimer?: NodeJS.Timeout;
  private quietEpoch = 0;
  private bufferedOutput: BufferedOutput[] = [];
  private bufferedOutputBytes = 0;
  private outputDrainQueued = false;
  private outputOverflowed = false;
  private readonly staleOutputGenerations = new Set<number>();
  private partialLines: Record<StreamOutputChannel, string> = { stdout: "", stderr: "" };
  private discardUntilNewline: Record<StreamOutputChannel, boolean> = {
    stdout: false,
    stderr: false,
  };
  private batch = "";
  private batchHasLines = false;
  private pendingBatch?: string;
  private firing?: InFlightBatch;
  private lastFireStartedAtMs: number;
  private nextEligibleAttemptAtMs: number;
  private consecutiveFailures: number;
  private droppedBatches: number;
  private coalescedBatches: number;

  constructor(
    job: StreamCronJob,
    private readonly params: OwnerParams,
  ) {
    this.job = job;
    this.scheduleKey = cronStreamScheduleKey(job.schedule);
    this.matcher = this.compileMatcher(job.schedule);
    this.lastFireStartedAtMs = job.state.lastRunAtMs ?? 0;
    this.nextEligibleAttemptAtMs = job.state.lastRunAtMs
      ? job.state.lastRunAtMs + params.minIntervalMs
      : 0;
    this.consecutiveFailures = job.state.streamConsecutiveFailures ?? 0;
    this.droppedBatches = job.state.streamDroppedBatches ?? 0;
    this.coalescedBatches = job.state.streamCoalescedBatches ?? 0;
    this.restartExhausted = job.state.streamRestartExhausted === true;
  }

  get id(): string {
    return this.job.id;
  }

  ownsSchedule(job: StreamCronJob): boolean {
    return cronStreamScheduleKey(job.schedule) === this.scheduleKey;
  }

  acceptsStart(): boolean {
    return !this.removalRequested;
  }

  snapshot(): StreamOwnerSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      processAlive: this.run !== undefined,
      restartTimerPending: this.restartTimer !== undefined,
      bufferedOutputBytes: this.bufferedOutputBytes,
      bufferedOutputSegments: this.bufferedOutput.length,
      droppedBatches: this.droppedBatches,
      coalescedBatches: this.coalescedBatches,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  start(job: StreamCronJob): Promise<void> {
    if (this.removalRequested) {
      return Promise.resolve();
    }
    const requestEpoch = ++this.requestEpoch;
    return this.enqueue("start", async () => {
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      const nextScheduleKey = cronStreamScheduleKey(job.schedule);
      if (nextScheduleKey !== this.scheduleKey) {
        await this.stopOperation("schedule-update");
      }
      // A newer disable/shutdown can arrive while schedule replacement is
      // stopping the old child. The older queued start must not reopen it.
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      if (this.run && this.state !== "running") {
        // A prior stop timed out but retained the child handle. Re-enable must
        // finish that teardown before it can spawn another source in the same
        // supervisor scope.
        await this.stopOperation("schedule-update");
        if (this.removalRequested || requestEpoch !== this.requestEpoch) {
          return;
        }
      }
      this.retired = false;
      this.desiredRunning = true;
      this.job = job;
      this.scheduleKey = nextScheduleKey;
      this.matcher = this.compileMatcher(job.schedule);
      this.droppedBatches = Math.max(
        this.droppedBatches,
        Math.min(COUNTER_MAX, Math.max(0, Math.floor(job.state.streamDroppedBatches ?? 0))),
      );
      this.coalescedBatches = Math.max(
        this.coalescedBatches,
        Math.min(COUNTER_MAX, Math.max(0, Math.floor(job.state.streamCoalescedBatches ?? 0))),
      );
      if (job.state.streamRestartExhausted) {
        this.desiredRunning = false;
        this.state = "stopped";
        return;
      }
      if (this.state === "running" || this.state === "starting" || this.state === "backoff") {
        return;
      }
      this.consecutiveFailures = job.state.streamConsecutiveFailures ?? 0;
      await this.spawnSource();
    });
  }

  stop(reason: StreamStopReason): Promise<void> {
    // Fence event admission synchronously. The queued stop may wait behind an
    // older owner op, but batches observed after stop was requested must not
    // dispatch while that op drains.
    ++this.requestEpoch;
    this.desiredRunning = false;
    if (reason === "removed") {
      // Synchronous admission fencing is part of the owner: starts submitted
      // after removal cannot sit behind stop and revive an untracked child.
      this.removalRequested = true;
    }
    // This is a cancellation request, not an ownership transition: state,
    // generation, timers, and counters remain serialized in stopOperation.
    // Pre-canceling the supervisor scope ensures shutdown cannot leave a child
    // alive while an older owner op is stalled on diagnostic persistence.
    this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
    const queuedStop = this.enqueue("stop", async () => await this.stopOperation(reason));
    return this.awaitBoundedStop(queuedStop);
  }

  batchClosed(batch: string, generation: number): Promise<void> {
    return this.enqueue("batch-closed", async () => {
      await this.handleClosedBatch(batch, generation);
    });
  }

  processExited(exit: RunExit, generation: number): Promise<void> {
    return this.enqueue("process-exited", async () => {
      if (generation !== this.generation) {
        return;
      }
      if (this.state === "stopping") {
        return;
      }
      if (this.state !== "running") {
        return;
      }

      this.run?.detachOutput?.();
      this.run = undefined;
      clearTimer(this.stableTimer);
      this.stableTimer = undefined;
      // An output drain can have accepted a second bounded segment while its
      // first segment awaited persistence. Consume that owned tail before the
      // exit transition makes running-only drains ineligible.
      await this.drainBufferedOutput(generation);
      await this.flushSourceOutput(generation);
      // The exited process loses callback ownership before backoff begins.
      // Otherwise identical late output is counted only after the next spawn,
      // making loss accounting depend on restart-timer timing.
      const backoffGeneration = ++this.generation;

      const stable = exit.durationMs >= STABLE_RUN_MS;
      this.consecutiveFailures = stable ? 0 : boundedIncrement(this.consecutiveFailures);
      const message = `stream source exited (${exit.reason}, code ${exit.exitCode ?? "none"})`;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.dropPendingForTerminalStop();
        this.desiredRunning = false;
        this.state = "stopped";
        this.restartExhausted = true;
        await this.persistFailure(message, {
          streamStatus: "error",
          streamError: message,
          streamConsecutiveFailures: this.consecutiveFailures,
          streamRestartExhausted: true,
          streamLastExitAtMs: this.params.nowMs(),
        });
        return;
      }

      this.state = "backoff";
      await this.persistState({
        streamStatus: "restarting",
        streamError: message,
        streamConsecutiveFailures: this.consecutiveFailures,
        streamLastExitAtMs: this.params.nowMs(),
      });
      void this.scheduleRestart(
        stable ? 0 : errorBackoffMs(this.consecutiveFailures, this.params.retryBackoffMs),
        backoffGeneration,
      );
    });
  }

  scheduleRestart(delayMs: number, generation: number): Promise<void> {
    return this.enqueue("schedule-restart", async () => {
      if (
        !this.desiredRunning ||
        this.retired ||
        this.state !== "backoff" ||
        generation !== this.generation
      ) {
        return;
      }
      clearTimer(this.restartTimer);
      if (delayMs <= 0) {
        void this.restartAfterBackoff(generation);
        return;
      }
      this.restartTimer = setTimeout(() => {
        void this.restartAfterBackoff(generation);
      }, delayMs);
      this.restartTimer.unref?.();
    });
  }

  private enqueue(label: string, operation: () => Promise<void>): Promise<void> {
    const result = this.opTail.then(operation, operation);
    this.opTail = result.catch((error) => {
      this.params.logger.warn(
        { jobId: this.job.id, operation: label, err: String(error) },
        "cron-stream: owner operation failed",
      );
    });
    return result;
  }

  private async awaitBoundedStop(stop: Promise<void>): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        stop,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
            reject(new Error(`stream owner stop did not settle within ${OWNER_STOP_TIMEOUT_MS}ms`));
          }, OWNER_STOP_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimer(timeout);
    }
  }

  private compileMatcher(schedule: CronStreamSchedule): RegExp | undefined {
    return (schedule.mode ?? "line") === "match"
      ? (compileSafeRegex(schedule.match ?? "") ?? undefined)
      : undefined;
  }

  private matchesLine(line: string): boolean {
    return !this.matcher || testRegexWithBoundedInput(this.matcher, line);
  }

  private hasAcceptedSourceInput(): boolean {
    if (this.batchHasLines) {
      return true;
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    for (const channel of ["stdout", "stderr"] as const) {
      let text = this.partialLines[channel];
      let discardUntilNewline = this.discardUntilNewline[channel];
      for (const entry of this.bufferedOutput) {
        if (entry.channel === channel) {
          text += entry.chunk;
        }
      }
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const rawLine = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (discardUntilNewline) {
          discardUntilNewline = false;
          continue;
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (this.matchesLine(line)) {
          return true;
        }
      }
      if (discardUntilNewline || !text) {
        continue;
      }
      const line =
        Buffer.byteLength(text, "utf8") > maxBatchBytes
          ? truncateCronStreamBatch(text, maxBatchBytes)
          : text.endsWith("\r")
            ? text.slice(0, -1)
            : text;
      if (this.matchesLine(line)) {
        return true;
      }
    }
    return false;
  }

  private async spawnSource(): Promise<void> {
    if (!this.desiredRunning || this.retired) {
      this.state = "stopped";
      return;
    }
    this.state = "starting";
    // A fresh spawn (re-enable, manual restart, replacement) clears any prior
    // terminal exhaustion so a later shutdown does not preserve a stale one.
    this.restartExhausted = false;
    const generation = ++this.generation;
    this.resetSourceBuffers();
    const ownsPersistedJob = await this.persistState({
      streamStatus: this.consecutiveFailures > 0 ? "restarting" : "starting",
      streamError: undefined,
      streamConsecutiveFailures: this.consecutiveFailures,
      streamRestartExhausted: undefined,
    });
    if (
      !ownsPersistedJob ||
      generation !== this.generation ||
      !this.desiredRunning ||
      this.retired ||
      this.state !== "starting"
    ) {
      this.state = "stopped";
      return;
    }

    let run: ManagedRun;
    try {
      run = await this.params.getProcessSupervisor().spawn({
        sessionId: `cron-stream:${this.job.id}`,
        backendId: "cron-stream-source",
        scopeKey: scopeKey(this.job.id),
        replaceExistingScope: true,
        mode: "child",
        argv: this.job.schedule.command,
        ...(this.job.schedule.cwd ? { cwd: this.job.schedule.cwd } : {}),
        env: markOpenClawExecEnv({ ...process.env }),
        stdinMode: "pipe-closed",
        captureOutput: false,
        onStdout: (chunk) => this.enqueueOutput("stdout", chunk, generation),
        onStderr: (chunk) => this.enqueueOutput("stderr", chunk, generation),
      });
    } catch (error) {
      if (generation !== this.generation || !this.desiredRunning || this.retired) {
        this.state = "stopped";
        return;
      }
      this.consecutiveFailures = boundedIncrement(this.consecutiveFailures);
      const message = `stream source failed to start: ${String(error)}`;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.dropPendingForTerminalStop();
        this.desiredRunning = false;
        this.state = "stopped";
        this.restartExhausted = true;
        await this.persistFailure(message, {
          streamStatus: "error",
          streamError: message,
          streamConsecutiveFailures: this.consecutiveFailures,
          streamRestartExhausted: true,
        });
        return;
      }
      this.state = "backoff";
      await this.persistState({
        streamStatus: "restarting",
        streamError: message,
        streamConsecutiveFailures: this.consecutiveFailures,
      });
      void this.scheduleRestart(
        errorBackoffMs(this.consecutiveFailures, this.params.retryBackoffMs),
        generation,
      );
      return;
    }

    if (generation !== this.generation || !this.desiredRunning || this.retired) {
      // Keep supervising a late spawn until exit is confirmed. If the first
      // cancellation times out, the queued stop still owns the same handle and
      // can retry instead of falsely reporting an empty owner.
      this.run = run;
      await stopManagedRun(run);
      if (this.run === run) {
        this.run = undefined;
      }
      this.state = "stopped";
      return;
    }
    this.run = run;
    this.state = "running";
    this.stableTimer = setTimeout(() => {
      void this.markStable(generation);
    }, STABLE_RUN_MS);
    this.stableTimer.unref?.();
    const ownsRunningJob = await this.persistState({
      streamStatus: "running",
      streamError: undefined,
      streamLastStartedAtMs: run.startedAtMs,
    });
    if (
      !ownsRunningJob ||
      generation !== this.generation ||
      !this.desiredRunning ||
      this.retired ||
      this.state !== "running"
    ) {
      await this.stopOperation("schedule-update");
      return;
    }
    this.params.logger.info(
      { jobId: this.job.id, runId: run.runId, generation },
      "cron-stream: source running",
    );
    this.schedulePendingIfNeeded(generation);
    void run.wait().then(
      (exit) => this.processExited(exit, generation),
      (error) => {
        this.params.logger.warn(
          { jobId: this.job.id, err: String(error) },
          "cron-stream: supervised wait failed",
        );
        return this.processExited(
          {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
            durationMs: Math.max(0, this.params.nowMs() - run.startedAtMs),
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          },
          generation,
        );
      },
    );
  }

  private async stopOperation(reason: StreamStopReason): Promise<void> {
    this.desiredRunning = false;
    if (reason === "removed") {
      this.retired = true;
    }
    this.state = "stopping";
    ++this.generation;
    clearTimer(this.restartTimer);
    this.restartTimer = undefined;
    clearTimer(this.stableTimer);
    this.stableTimer = undefined;
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    clearTimer(this.rateTimer);
    this.rateTimer = undefined;
    ++this.quietEpoch;

    const sourceBatchLost = this.hasAcceptedSourceInput();
    const pendingBatchLost = this.pendingBatch !== undefined;
    this.batch = "";
    this.batchHasLines = false;
    this.pendingBatch = undefined;
    this.partialLines = { stdout: "", stderr: "" };
    this.discardUntilNewline = { stdout: false, stderr: false };
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    this.outputOverflowed = false;

    const run = this.run;
    let stopError: unknown;
    if (run) {
      try {
        await stopManagedRun(run);
        if (this.run === run) {
          this.run = undefined;
        }
      } catch (error) {
        stopError = error;
      }
    } else {
      this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
    }

    if (sourceBatchLost) {
      await this.recordLoss("not-running");
    }
    if (pendingBatchLost) {
      await this.recordLoss("not-running");
    }
    const firing = this.firing;
    if (firing && !firing.handled) {
      const result = await waitForInFlightBatch(firing.promise);
      if (!result.settled) {
        await this.recordLoss("not-running");
        firing.handled = true;
      } else if ("error" in result) {
        this.params.logger.warn(
          { jobId: this.job.id, err: String(result.error) },
          "cron-stream: batch fire failed during stop",
        );
        await this.recordLoss("payload-error");
        firing.handled = true;
      } else {
        await this.classifyFireDisposition(firing, result.disposition, true);
      }
    }
    this.firing = undefined;

    if (stopError !== undefined) {
      // The child is still owned and retryable; do not claim the closed state
      // until a later stop confirms process exit.
      this.state = "stopping";
      const message = `stream source failed to stop: ${String(stopError)}`;
      await this.persistFailure(message, {
        streamStatus: "error",
        streamError: message,
        streamRestartExhausted: true,
      });
      throw stopError;
    }
    this.state = "stopped";
    await this.persistState(
      reason === "trust-disabled"
        ? {
            streamStatus: "disabled",
            streamError: "stream sources require cron.triggers.enabled=true",
          }
        : reason === "cron-disabled"
          ? { streamStatus: "disabled", streamError: "cron is disabled" }
          : reason === "restart-exhausted" ||
              (reason === "shutdown" && this.restartExhausted)
            ? // Preserve the terminal restart-exhaustion diagnostic across a
              // normal gateway shutdown; overwriting it with a plain "stopped"
              // would erase why the source stopped restarting.
              {}
            : { streamStatus: "stopped", streamError: undefined },
    );
  }

  private enqueueOutput(channel: StreamOutputChannel, chunk: string, generation: number): void {
    if (!chunk) {
      return;
    }
    if (generation !== this.generation) {
      this.queueStaleGenerationLoss(generation);
      return;
    }
    if (this.state !== "starting" && this.state !== "running") {
      return;
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const remaining = maxBatchBytes - this.bufferedOutputBytes;
    if (remaining <= 0 || this.bufferedOutput.length >= MAX_BUFFERED_OUTPUT_SEGMENTS) {
      this.outputOverflowed = true;
      this.queueOutputDrain();
      return;
    }
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const preserveNewline = chunkBytes > remaining && chunk.includes("\n") && remaining > 1;
    const accepted =
      chunkBytes <= remaining
        ? chunk
        : `${truncateCronStreamBatch(chunk, remaining - (preserveNewline ? 1 : 0))}${
            preserveNewline ? "\n" : ""
          }`;
    if (Buffer.byteLength(accepted, "utf8") > remaining) {
      this.outputOverflowed = true;
      this.queueOutputDrain();
      return;
    }
    const last = this.bufferedOutput.at(-1);
    if (last?.channel === channel && last.generation === generation) {
      last.chunk += accepted;
    } else {
      this.bufferedOutput.push({ channel, chunk: accepted, generation });
    }
    this.bufferedOutputBytes += Buffer.byteLength(accepted, "utf8");
    if (accepted !== chunk) {
      this.outputOverflowed = true;
    }
    this.queueOutputDrain();
  }

  private queueStaleGenerationLoss(generation: number): void {
    if (
      !this.desiredRunning ||
      (this.state !== "starting" && this.state !== "running" && this.state !== "backoff") ||
      this.staleOutputGenerations.has(generation)
    ) {
      return;
    }
    this.staleOutputGenerations.add(generation);
    while (this.staleOutputGenerations.size > MAX_TRACKED_STALE_GENERATIONS) {
      const oldest = this.staleOutputGenerations.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.staleOutputGenerations.delete(oldest);
    }
    void this.enqueue("stale-output", async () => {
      // Stop wins at execution time. Late callbacks after a completed stop are
      // intentionally inert, while an obsolete live generation counts once.
      if (
        !this.desiredRunning ||
        generation === this.generation ||
        (this.state !== "starting" && this.state !== "running" && this.state !== "backoff")
      ) {
        return;
      }
      await this.recordLoss("stale-generation");
    });
  }

  private queueOutputDrain(): void {
    if (this.outputDrainQueued) {
      return;
    }
    this.outputDrainQueued = true;
    void this.enqueue("output", async () => {
      try {
        await this.drainBufferedOutput(this.generation);
      } finally {
        this.outputDrainQueued = false;
        if (this.bufferedOutput.length > 0 || this.outputOverflowed) {
          this.queueOutputDrain();
        }
      }
    });
  }

  private async drainBufferedOutput(generation: number): Promise<void> {
    const buffered = this.bufferedOutput;
    const overflowed = this.outputOverflowed;
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    this.outputOverflowed = false;
    for (const entry of buffered) {
      if (entry.generation !== generation || generation !== this.generation) {
        if (this.state !== "stopped") {
          await this.recordLoss("stale-generation");
        }
        continue;
      }
      if (this.state !== "running") {
        if (this.state !== "stopped") {
          await this.recordLoss("not-running");
        }
        continue;
      }
      await this.acceptChunk(entry.channel, entry.chunk, entry.generation);
    }
    if (overflowed && generation === this.generation && this.state === "running") {
      await this.recordLoss("coalesced");
    }
  }

  private async acceptChunk(
    channel: StreamOutputChannel,
    chunk: string,
    generation: number,
  ): Promise<void> {
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    let text = `${this.partialLines[channel]}${chunk}`;
    this.partialLines[channel] = "";
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const rawLine = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (this.discardUntilNewline[channel]) {
        this.discardUntilNewline[channel] = false;
        continue;
      }
      await this.acceptLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, generation);
    }
    if (this.discardUntilNewline[channel]) {
      return;
    }
    if (Buffer.byteLength(text, "utf8") > maxBatchBytes) {
      await this.acceptLine(truncateCronStreamBatch(text, maxBatchBytes), generation);
      this.discardUntilNewline[channel] = true;
      return;
    }
    this.partialLines[channel] = text;
  }

  private async acceptLine(line: string, generation: number): Promise<void> {
    if (!this.matchesLine(line)) {
      return;
    }
    const { batchMs, maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const candidate = this.batchHasLines ? `${this.batch}\n${line}` : line;
    const capped = truncateCronStreamBatch(candidate, maxBatchBytes);
    this.batch = capped;
    this.batchHasLines = true;
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    const epoch = ++this.quietEpoch;
    if (capped !== candidate || Buffer.byteLength(capped, "utf8") >= maxBatchBytes) {
      const batch = this.takeOpenBatch();
      if (batch !== undefined) {
        await this.handleClosedBatch(batch, generation);
      }
      return;
    }
    this.quietTimer = setTimeout(() => {
      void this.closeQuietBatch(generation, epoch);
    }, batchMs);
    this.quietTimer.unref?.();
  }

  private closeQuietBatch(generation: number, epoch: number): Promise<void> {
    return this.enqueue("batch-closed", async () => {
      if (generation !== this.generation) {
        if (this.state !== "stopped") {
          await this.recordLoss("stale-generation");
        }
        return;
      }
      if (this.state !== "running" || epoch !== this.quietEpoch) {
        if (this.state !== "stopped" && epoch === this.quietEpoch && this.batchHasLines) {
          this.takeOpenBatch();
          await this.recordLoss("not-running");
        }
        return;
      }
      clearTimer(this.quietTimer);
      this.quietTimer = undefined;
      const batch = this.takeOpenBatch();
      if (batch !== undefined) {
        await this.handleClosedBatch(batch, generation);
      }
    });
  }

  private takeOpenBatch(): string | undefined {
    if (!this.batchHasLines) {
      return undefined;
    }
    const batch = this.batch;
    this.batch = "";
    this.batchHasLines = false;
    return batch;
  }

  private async flushSourceOutput(generation: number): Promise<void> {
    for (const channel of ["stdout", "stderr"] as const) {
      const partialLine = this.partialLines[channel];
      if (!this.discardUntilNewline[channel] && partialLine) {
        await this.acceptLine(
          partialLine.endsWith("\r") ? partialLine.slice(0, -1) : partialLine,
          generation,
        );
      }
      this.partialLines[channel] = "";
      this.discardUntilNewline[channel] = false;
    }
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    const batch = this.takeOpenBatch();
    if (batch !== undefined) {
      await this.handleClosedBatch(batch, generation);
    }
  }

  private async handleClosedBatch(batch: string, generation: number): Promise<void> {
    if (generation !== this.generation) {
      // A fully stopped owner has already accounted for every owned open,
      // pending, and in-flight batch. Late callbacks must not move counters.
      if (this.state !== "stopped") {
        await this.recordLoss("stale-generation");
      }
      return;
    }
    if (!this.desiredRunning || this.state !== "running") {
      if (this.state !== "stopped") {
        await this.recordLoss("not-running");
      }
      return;
    }

    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const spacingRemaining =
      Math.max(this.nextEligibleAttemptAtMs, this.lastFireStartedAtMs + this.params.minIntervalMs) -
      this.params.nowMs();
    if (this.firing || spacingRemaining > 0 || this.pendingBatch !== undefined) {
      this.pendingBatch = appendBatch(this.pendingBatch, batch, maxBatchBytes);
      await this.recordLoss("coalesced");
      if (!this.firing) {
        this.schedulePendingFire(Math.max(0, spacingRemaining), generation);
      }
      return;
    }
    this.startFire(batch, generation);
  }

  private startFire(batch: string, generation: number): void {
    // Single choke point for every fire path (immediate and pending flush): a
    // batch captured under an earlier source generation must not execute after
    // a disable/re-enable or replacement — even when the schedule is unchanged,
    // the process it came from is retired. Drop it as a counted loss instead.
    if (generation !== this.generation || !this.desiredRunning || this.retired) {
      void this.recordLoss("stale-generation");
      return;
    }
    const attemptStartedAtMs = this.params.nowMs();
    this.nextEligibleAttemptAtMs = attemptStartedAtMs + this.params.minIntervalMs;
    const firing: InFlightBatch = {
      batch,
      generation,
      startedAtMs: attemptStartedAtMs,
      promise: this.params.fireBatch(this.job, batch, this.scheduleKey),
      handled: false,
    };
    this.firing = firing;
    void firing.promise.then(
      (disposition) => this.fireCompleted(firing, disposition),
      (error) => this.fireRejected(firing, error),
    );
  }

  private fireCompleted(
    firing: InFlightBatch,
    disposition: CronStreamFireDisposition,
  ): Promise<void> {
    return this.enqueue("fire-completed", async () => {
      if (firing.handled) {
        return;
      }
      if (this.firing !== firing) {
        if (this.state !== "stopped") {
          await this.recordLoss("stale-generation");
        }
        firing.handled = true;
        return;
      }
      await this.classifyFireDisposition(firing, disposition, false);
      this.firing = undefined;
      this.schedulePendingIfNeeded(this.generation);
    });
  }

  private fireRejected(firing: InFlightBatch, error: unknown): Promise<void> {
    return this.enqueue("fire-rejected", async () => {
      if (firing.handled) {
        return;
      }
      if (this.firing !== firing) {
        firing.handled = true;
        return;
      }
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: batch fire failed",
      );
      await this.recordLoss("payload-error");
      firing.handled = true;
      this.firing = undefined;
      this.schedulePendingIfNeeded(this.generation);
    });
  }

  private async classifyFireDisposition(
    firing: InFlightBatch,
    disposition: CronStreamFireDisposition,
    stopping: boolean,
  ): Promise<void> {
    if (firing.handled) {
      return;
    }
    firing.handled = true;
    if (disposition === "fired" || disposition === "disabled") {
      // `disabled` is returned only after this batch fired successfully and a
      // once-trigger disabled the job; it is lifecycle state, not a lost batch.
      this.lastFireStartedAtMs = firing.startedAtMs;
      if (disposition === "disabled" && !stopping) {
        void this.stop("trigger-disabled").catch((error) => {
          this.params.logger.warn(
            { jobId: this.job.id, err: String(error) },
            "cron-stream: trigger-disabled stop failed",
          );
        });
      }
      return;
    }
    if (disposition === "dropped") {
      await this.recordLoss("gate-drop");
      return;
    }
    if (disposition === "error") {
      await this.recordLoss("payload-error");
      return;
    }
    if (disposition === "busy" && !stopping && this.desiredRunning && this.state !== "stopped") {
      const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
      this.pendingBatch =
        this.pendingBatch === undefined
          ? firing.batch
          : appendBatch(firing.batch, this.pendingBatch, maxBatchBytes);
      return;
    }
    await this.recordLoss("not-running");
  }

  private schedulePendingIfNeeded(generation: number): void {
    if (this.pendingBatch === undefined || this.state !== "running") {
      return;
    }
    const nextAt = Math.max(
      this.nextEligibleAttemptAtMs,
      this.lastFireStartedAtMs + this.params.minIntervalMs,
    );
    this.schedulePendingFire(Math.max(0, nextAt - this.params.nowMs()), generation);
  }

  private schedulePendingFire(delayMs: number, generation: number): void {
    clearTimer(this.rateTimer);
    this.rateTimer = setTimeout(() => {
      void this.attemptPendingFire(generation);
    }, delayMs);
    this.rateTimer.unref?.();
  }

  private attemptPendingFire(generation: number): Promise<void> {
    return this.enqueue("pending-fire", async () => {
      this.rateTimer = undefined;
      if (this.pendingBatch === undefined) {
        return;
      }
      if (generation !== this.generation) {
        if (this.desiredRunning && this.state === "running") {
          this.schedulePendingIfNeeded(this.generation);
          return;
        }
        if (this.desiredRunning && (this.state === "starting" || this.state === "backoff")) {
          return;
        }
        if (this.state !== "stopped") {
          this.pendingBatch = undefined;
          await this.recordLoss("stale-generation");
        }
        return;
      }
      if (this.state === "starting" || this.state === "backoff") {
        // Output flushed from the previous generation remains owned while the
        // source restarts. spawnSource reschedules it after the new child runs.
        return;
      }
      if (!this.desiredRunning) {
        this.pendingBatch = undefined;
        if (this.state !== "stopped") {
          await this.recordLoss("not-running");
        }
        return;
      }
      if (this.state !== "running") {
        if (this.state !== "stopped") {
          this.pendingBatch = undefined;
          await this.recordLoss("not-running");
        }
        return;
      }
      if (this.firing) {
        return;
      }
      const spacingRemaining =
        Math.max(
          this.nextEligibleAttemptAtMs,
          this.lastFireStartedAtMs + this.params.minIntervalMs,
        ) - this.params.nowMs();
      if (spacingRemaining > 0) {
        this.schedulePendingFire(spacingRemaining, generation);
        return;
      }
      const pending = this.pendingBatch;
      this.pendingBatch = undefined;
      this.startFire(pending, generation);
    });
  }

  private markStable(generation: number): Promise<void> {
    return this.enqueue("mark-stable", async () => {
      if (generation !== this.generation || this.state !== "running") {
        return;
      }
      this.stableTimer = undefined;
      this.consecutiveFailures = 0;
      const ownsPersistedJob = await this.persistState({
        streamStatus: "running",
        streamError: undefined,
        streamConsecutiveFailures: 0,
      });
      if (!ownsPersistedJob) {
        await this.stopOperation("schedule-update");
      }
    });
  }

  private restartAfterBackoff(generation: number): Promise<void> {
    return this.enqueue("restart", async () => {
      if (
        generation !== this.generation ||
        this.state !== "backoff" ||
        !this.desiredRunning ||
        this.retired
      ) {
        return;
      }
      clearTimer(this.restartTimer);
      this.restartTimer = undefined;
      await this.spawnSource();
    });
  }

  /**
   * All loss accounting has one owner. Gate, lifecycle, payload, and stale
   * losses map to streamDroppedBatches; coalescing maps to streamCoalescedBatches.
   */
  private async recordLoss(reason: StreamLossReason): Promise<void> {
    if (reason === "coalesced") {
      this.coalescedBatches = boundedIncrement(this.coalescedBatches);
    } else {
      this.droppedBatches = boundedIncrement(this.droppedBatches);
    }
    try {
      const counters = {
        streamDroppedBatches: this.droppedBatches,
        streamCoalescedBatches: this.coalescedBatches,
      };
      if (this.params.updateCounters) {
        await this.params.updateCounters(this.job.id, counters);
      } else {
        await this.params.updateState(this.job.id, counters, this.scheduleKey);
      }
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: failed to persist loss counters",
      );
    }
  }

  private async dropPendingForTerminalStop(): Promise<void> {
    clearTimer(this.rateTimer);
    this.rateTimer = undefined;
    if (this.pendingBatch === undefined) {
      return;
    }
    this.pendingBatch = undefined;
    await this.recordLoss("not-running");
  }

  private async persistState(patch: Partial<CronJobState>): Promise<boolean> {
    try {
      const result = await this.params.updateState(this.job.id, patch, this.scheduleKey);
      if (result === false) {
        this.desiredRunning = false;
        return false;
      }
      return true;
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: failed to persist source state",
      );
      // Diagnostic persistence failure is non-authoritative. The service's
      // explicit `false` ownership result, not an I/O error, retires a source.
      return true;
    }
  }

  private async persistFailure(error: string, patch: Partial<CronJobState>): Promise<void> {
    try {
      await this.params.recordFailure(this.job.id, error, patch, this.scheduleKey);
    } catch (failureError) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(failureError) },
        "cron-stream: failed to persist terminal source failure",
      );
    }
  }

  private resetSourceBuffers(): void {
    clearTimer(this.quietTimer);
    this.quietTimer = undefined;
    ++this.quietEpoch;
    this.partialLines = { stdout: "", stderr: "" };
    this.discardUntilNewline = { stdout: false, stderr: false };
    this.batch = "";
    this.batchHasLines = false;
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    this.outputDrainQueued = false;
    this.outputOverflowed = false;
  }
}

/** Supervise line-producing cron sources through one serialized owner per job. */
export function createCronStreamWatchers(params: {
  getProcessSupervisor: () => ProcessSupervisor;
  cronConfig?: { triggers?: { minIntervalMs?: number }; retry?: CronRetryConfig };
  updateState: (
    jobId: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
  ) => Promise<boolean | void>;
  updateCounters?: (
    jobId: string,
    counters: Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">,
  ) => Promise<void>;
  recordFailure: (
    jobId: string,
    error: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
  ) => Promise<void>;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
  ) => Promise<CronStreamFireDisposition>;
  logger: Logger;
  nowMs?: () => number;
}): CronStreamWatchers {
  const owners = new Map<string, StreamJobOwner>();
  const retiredCounterSeeds = new Map<
    string,
    Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">
  >();
  // Per-job mutation tokens let an in-flight reconcile detect that a specific
  // job was directly started/stopped while it awaited, and skip that job rather
  // than apply a stale list-snapshot decision. Tokens are drawn from a single
  // process-wide monotonically increasing source, never a per-id increment:
  // that makes the map safe to bound with an insertion-order (LRU) cap. An
  // evicted id re-enters with a brand-new higher token, so it can never reuse a
  // value an in-flight reconcile captured (a per-id reset to 1 could — that is
  // an ABA hole). A read of an absent/evicted id returns 0, which fails
  // jobMutationIsCurrent: the safe direction (a stale reconcile skips).
  const mutationEpochs = new Map<string, number>();
  let nextMutationToken = 0;
  let reconcileEpoch = 0;
  let stopped = false;
  const mutationEpochFor = (jobId: string) => mutationEpochs.get(jobId) ?? 0;
  const bumpMutationEpoch = (jobId: string) => {
    const next = ++nextMutationToken;
    // Re-insert last so recently-touched ids sort newest for LRU eviction.
    mutationEpochs.delete(jobId);
    mutationEpochs.set(jobId, next);
    while (mutationEpochs.size > MAX_MUTATION_EPOCHS) {
      const oldest = mutationEpochs.keys().next().value;
      if (oldest === undefined || oldest === jobId) {
        break;
      }
      mutationEpochs.delete(oldest);
    }
    return next;
  };
  const ownerParams: OwnerParams = {
    getProcessSupervisor: params.getProcessSupervisor,
    minIntervalMs: resolveCronTriggerMinIntervalMs(params.cronConfig),
    retryBackoffMs: params.cronConfig?.retry?.backoffMs,
    updateState: params.updateState,
    ...(params.updateCounters ? { updateCounters: params.updateCounters } : {}),
    recordFailure: params.recordFailure,
    fireBatch: params.fireBatch,
    logger: params.logger,
    nowMs: params.nowMs ?? Date.now,
  };

  const retainCounterSeed = (owner: StreamJobOwner): void => {
    const snapshot = owner.snapshot();
    const current = retiredCounterSeeds.get(owner.id);
    retiredCounterSeeds.delete(owner.id);
    retiredCounterSeeds.set(owner.id, {
      streamDroppedBatches: Math.max(current?.streamDroppedBatches ?? 0, snapshot.droppedBatches),
      streamCoalescedBatches: Math.max(
        current?.streamCoalescedBatches ?? 0,
        snapshot.coalescedBatches,
      ),
    });
    while (retiredCounterSeeds.size > MAX_RETIRED_COUNTER_SEEDS) {
      const oldest = retiredCounterSeeds.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      retiredCounterSeeds.delete(oldest);
    }
  };

  const createOwner = (job: StreamCronJob): StreamJobOwner => {
    const seed = retiredCounterSeeds.get(job.id);
    retiredCounterSeeds.delete(job.id);
    const seededJob = seed
      ? {
          ...job,
          state: {
            ...job.state,
            streamDroppedBatches: Math.max(
              job.state.streamDroppedBatches ?? 0,
              seed.streamDroppedBatches ?? 0,
            ),
            streamCoalescedBatches: Math.max(
              job.state.streamCoalescedBatches ?? 0,
              seed.streamCoalescedBatches ?? 0,
            ),
          },
        }
      : job;
    const owner = new StreamJobOwner(seededJob, ownerParams);
    owners.set(job.id, owner);
    return owner;
  };

  const getOrCreateOwner = async (
    job: StreamCronJob,
    isCurrent: () => boolean,
  ): Promise<StreamJobOwner | undefined> => {
    while (true) {
      if (!isCurrent()) {
        return undefined;
      }
      const existing = owners.get(job.id);
      if (existing?.acceptsStart()) {
        return existing;
      }
      if (!existing) {
        return createOwner(job);
      }
      await existing.stop("removed");
      if (!isCurrent()) {
        return undefined;
      }
      if (owners.get(job.id) === existing) {
        retainCounterSeed(existing);
        owners.delete(job.id);
      }
    }
  };

  const startOwner = async (
    job: CronJob,
    expectedMutationEpoch: number,
    expectedReconcileEpoch?: number,
  ): Promise<void> => {
    const isCurrent = () =>
      !stopped &&
      expectedMutationEpoch === mutationEpochFor(job.id) &&
      (expectedReconcileEpoch === undefined || expectedReconcileEpoch === reconcileEpoch);
    if (!isCurrent()) {
      return;
    }
    if (!isStreamJob(job)) {
      await stop(job.id, "schedule-update");
      return;
    }
    const owner = await getOrCreateOwner(job, isCurrent);
    if (!owner || !isCurrent()) {
      return;
    }
    if (!owner.ownsSchedule(job)) {
      // Enqueue both transitions immediately; a restart callback queued later
      // cannot interpose between replacement stop and replacement start.
      const stopped = owner.stop("schedule-update");
      const started = owner.start(job);
      await stopped;
      await started;
      return;
    }
    await owner.start(job);
  };

  const start = async (job: CronJob): Promise<void> => {
    const expectedMutationEpoch = bumpMutationEpoch(job.id);
    await startOwner(job, expectedMutationEpoch);
  };

  const stop = async (jobId: string, reason: StreamStopReason, job?: CronJob): Promise<void> => {
    bumpMutationEpoch(jobId);
    const owner =
      owners.get(jobId) ??
      (reason !== "removed" && job && isStreamJob(job) ? createOwner(job) : undefined);
    if (!owner) {
      return;
    }
    await owner.stop(reason);
    if (reason === "removed" && owners.get(jobId) === owner) {
      retainCounterSeed(owner);
      owners.delete(jobId);
    }
  };

  const stopAll = async (reason: StreamStopReason): Promise<void> => {
    if (reason === "shutdown") {
      stopped = true;
      ++reconcileEpoch;
    }
    await Promise.all(Array.from(owners.values(), (owner) => owner.stop(reason)));
  };

  const reconcile = async (
    jobs: CronJob[],
    enabled: boolean,
    triggersEnabled = enabled,
  ): Promise<void> => {
    const currentReconcileEpoch = ++reconcileEpoch;
    if (stopped) {
      return;
    }
    const streamJobs = jobs.filter(isStreamJob);
    const wantedIds = new Set(streamJobs.map((job) => job.id));
    const mutationSnapshot = new Map<string, number>();
    for (const jobId of new Set([...owners.keys(), ...wantedIds])) {
      mutationSnapshot.set(jobId, mutationEpochFor(jobId));
    }
    const jobMutationIsCurrent = (jobId: string) =>
      mutationEpochFor(jobId) === mutationSnapshot.get(jobId);
    for (const [jobId, owner] of owners.entries()) {
      if (wantedIds.has(jobId)) {
        continue;
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(jobId)) {
        continue;
      }
      await owner.stop("removed");
      if (owners.get(jobId) === owner) {
        retainCounterSeed(owner);
        owners.delete(jobId);
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
    }
    if (stopped || currentReconcileEpoch !== reconcileEpoch) {
      return;
    }
    for (const job of streamJobs) {
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(job.id)) {
        continue;
      }
      const owner = await getOrCreateOwner(
        job,
        () => !stopped && currentReconcileEpoch === reconcileEpoch && jobMutationIsCurrent(job.id),
      );
      if (!owner) {
        return;
      }
      if (stopped || currentReconcileEpoch !== reconcileEpoch) {
        return;
      }
      if (!jobMutationIsCurrent(job.id)) {
        continue;
      }
      if (!enabled) {
        // Report the actual cause: triggers off vs cron globally off.
        await owner.stop(triggersEnabled ? "cron-disabled" : "trust-disabled");
        continue;
      }
      if (!job.enabled) {
        await owner.stop("disabled");
        continue;
      }
      if (job.state.streamRestartExhausted) {
        await owner.stop("restart-exhausted");
        continue;
      }
      await startOwner(job, mutationSnapshot.get(job.id) ?? 0, currentReconcileEpoch);
    }
  };

  return {
    reconcile,
    resume: () => {
      stopped = false;
      ++reconcileEpoch;
    },
    start,
    stop,
    stopAll,
    activeJobIds: () =>
      Array.from(owners.values())
        .filter((owner) => {
          const state = owner.snapshot().state;
          return (
            state === "starting" ||
            state === "running" ||
            state === "stopping" ||
            state === "backoff"
          );
        })
        .map((owner) => owner.id),
    inspect: (jobId) => owners.get(jobId)?.snapshot(),
  };
}
