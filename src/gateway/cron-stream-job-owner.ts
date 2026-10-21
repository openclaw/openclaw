import { StringDecoder } from "node:string_decoder";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { errorBackoffMs } from "../cron/service/jobs-scheduling.js";
import { CronStreamSourceRetirementError, cronStreamScheduleKey } from "../cron/stream-schedule.js";
import type { CronJobState, CronStoredJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduledJob, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  CronStreamOutput,
  type CronStreamJob,
  type CronStreamLossReason,
  type CronStreamOwnerState,
} from "./cron-stream-output.js";
import type { CronStreamOwnerParams, CronStreamStopReason } from "./cron-stream-owner-types.js";
import { assertCronStreamExtinction, stopCronStreamRun } from "./cron-stream-stop.js";

const SCOPE_PREFIX = "cron-stream";
const STABLE_RUN_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const COUNTER_MAX = 2_147_483_647;
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const OWNER_STOP_TIMEOUT_MS = STOP_SETTLE_TIMEOUT_MS * 2;

export type { CronStreamOwnerParams, CronStreamStopReason } from "./cron-stream-owner-types.js";

export function isCronStreamJob(job: CronStoredJob): job is CronStreamJob {
  return job.schedule.kind === "stream";
}

function sourceIdentityFor(job: CronStreamJob): string {
  const identity = job.state.streamSourceIdentity?.trim();
  if (!identity) {
    throw new Error(`stream job ${job.id} is missing its source identity`);
  }
  return identity;
}

const scopeKey = (jobId: string): string => `${SCOPE_PREFIX}:${jobId}`;

function stopRequiresSourceRetirement(reason: CronStreamStopReason): boolean {
  return (
    reason === "removed" ||
    reason === "shutdown" ||
    reason === "trust-disabled" ||
    reason === "cron-disabled"
  );
}

function boundedCounter(value: number | undefined, increment = 0): number {
  return Math.min(COUNTER_MAX, Math.max(0, Math.floor(value ?? 0)) + increment);
}

/** Owns one stream job's serialized process lifecycle and durable counters. */
export class CronStreamJobOwner {
  private state: CronStreamOwnerState = "idle";
  private desiredRunning = false;
  private removalRequested = false;
  // Preserve terminal restart exhaustion across a normal shutdown state write.
  private restartExhausted = false;
  private restartFailure?: string;
  private requestEpoch = 0;
  private runningRequestEpoch?: number;
  private cleanupHostScope?: () => Promise<void>;
  private opTail: Promise<void> = Promise.resolve();
  private job: CronStreamJob;
  private scheduleKey: string;
  private sourceIdentity: string;
  private scheduler: GatewaySchedulerScope;
  private run?: ManagedRun;
  private restartJob?: GatewayScheduledJob;
  private stableJob?: GatewayScheduledJob;
  private consecutiveFailures: number;
  private droppedBatches: number;
  private coalescedBatches: number;
  private readonly output: CronStreamOutput;

  constructor(
    job: CronStreamJob,
    private readonly params: CronStreamOwnerParams,
  ) {
    this.job = job;
    this.scheduleKey = cronStreamScheduleKey(job.schedule, job.streamSandbox);
    this.sourceIdentity = sourceIdentityFor(job);
    this.scheduler = params.scheduler.scope();
    this.consecutiveFailures = job.state.streamConsecutiveFailures ?? 0;
    this.droppedBatches = job.state.streamDroppedBatches ?? 0;
    this.coalescedBatches = job.state.streamCoalescedBatches ?? 0;
    this.restartExhausted = job.state.streamRestartExhausted === true;
    this.restartFailure = this.restartExhausted ? job.state.streamError : undefined;
    this.output = new CronStreamOutput({
      job,
      scheduleKey: this.scheduleKey,
      sourceIdentity: this.sourceIdentity,
      minIntervalMs: params.minIntervalMs,
      settleTimeoutMs: STOP_SETTLE_TIMEOUT_MS,
      scheduler: this.scheduler,
      fireBatch: params.fireBatch,
      recordLoss: async (reason) => await this.recordLoss(reason),
      enqueue: (label, operation) => this.enqueue(label, operation),
      requestTriggerDisabledStop: () => {
        void this.stop("trigger-disabled").catch((error: unknown) => {
          this.params.logger.warn(
            { jobId: this.job.id, err: formatErrorMessage(error) },
            "cron-stream: trigger-disabled stop failed",
          );
        });
      },
      requestMatchFailureStop: (error) => {
        void this.stop("restart-exhausted", undefined, error).catch((stopError: unknown) => {
          this.params.logger.warn(
            { jobId: this.job.id, err: formatErrorMessage(stopError) },
            "cron-stream: match failure teardown failed",
          );
        });
      },
      getState: () => this.state,
      isDesiredRunning: () => this.desiredRunning,
      logger: params.logger,
    });
  }

  get id(): string {
    return this.job.id;
  }

  acceptsStart(): boolean {
    return !this.removalRequested;
  }

  snapshot() {
    return {
      state: this.state,
      sourceIdentity: this.sourceIdentity,
      processAlive: this.run !== undefined,
      restartTimerPending: this.restartJob !== undefined,
      ...this.output.snapshot(),
      droppedBatches: this.droppedBatches,
      coalescedBatches: this.coalescedBatches,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  async start(job: CronStreamJob): Promise<void> {
    if (this.removalRequested) {
      return;
    }
    const nextScheduleKey = cronStreamScheduleKey(job.schedule, job.streamSandbox);
    const nextSourceIdentity = sourceIdentityFor(job);
    // Reconciliation can retain a live run, but cannot revive one fenced by an earlier request.
    const retainRunningSource =
      this.run &&
      this.state === "running" &&
      this.desiredRunning &&
      this.runningRequestEpoch === this.requestEpoch &&
      !job.state.streamRestartExhausted &&
      this.ownsSource(nextScheduleKey, nextSourceIdentity);
    const requestEpoch = retainRunningSource ? this.requestEpoch : ++this.requestEpoch;
    return this.enqueue("start", async () => {
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      if (!this.ownsSource(nextScheduleKey, nextSourceIdentity)) {
        await this.stopOperation("schedule-update");
      }
      // A newer stop can arrive while replacement waits for the old child.
      if (this.removalRequested || requestEpoch !== this.requestEpoch) {
        return;
      }
      if (
        this.state === "stopping" ||
        (this.run && (this.state !== "running" || this.runningRequestEpoch !== requestEpoch))
      ) {
        await this.stopOperation("schedule-update");
        if (this.removalRequested || requestEpoch !== this.requestEpoch) {
          return;
        }
      }
      this.desiredRunning = true;
      this.adoptJob(job, nextScheduleKey, nextSourceIdentity);
      this.droppedBatches = Math.max(
        this.droppedBatches,
        boundedCounter(job.state.streamDroppedBatches),
      );
      this.coalescedBatches = Math.max(
        this.coalescedBatches,
        boundedCounter(job.state.streamCoalescedBatches),
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

  stop(reason: CronStreamStopReason, job?: CronStreamJob, failure?: string): Promise<void> {
    // Fence output and queued starts synchronously, before the stop operation runs.
    ++this.requestEpoch;
    this.desiredRunning = false;
    this.run?.cancel("manual-cancel");
    const scheduler = this.scheduler;
    scheduler.beginClose();
    this.output.cancelMatching();
    if (reason === "removed") {
      this.removalRequested = true;
    }
    this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
    const queuedStop = this.enqueue("stop", async () => {
      if (failure) {
        this.restartExhausted = true;
        this.restartFailure = failure;
        await this.persistFailure(failure, {
          streamStatus: "error",
          streamError: failure,
          streamRestartExhausted: true,
        });
      }
      await this.stopOperation(reason, job);
    });
    // Scheduled callbacks can be waiting on this queue; join only outside its tail.
    const settleStop = async () => {
      try {
        await queuedStop;
      } finally {
        await scheduler.stop();
      }
    };
    return this.awaitBoundedStop(settleStop());
  }

  processExited(exit: RunExit, run: ManagedRun): Promise<void> {
    return this.enqueue("process-exited", async () => {
      // desiredRunning is the synchronous stop fence: an exit that queued
      // ahead of a requested stop belongs to that stop, not to the failure
      // counters — counting it could fabricate restart exhaustion for a
      // deliberate disable/removal/shutdown.
      if (this.run !== run || this.state !== "running" || !this.desiredRunning) {
        return;
      }
      // Transport exit cannot prove that the dedicated sandbox workload is extinct.
      try {
        if (run.waitForExtinction) {
          assertCronStreamExtinction(await run.waitForExtinction());
        }
        await this.releaseHostScope();
      } catch (error) {
        run.detachOutput?.();
        await this.stopOperation(
          "restart-exhausted",
          undefined,
          toErrorObject(error, "stream source extinction is unconfirmed"),
        );
        return;
      }
      this.run?.detachOutput?.();
      this.run = undefined;
      this.stableJob?.cancel();
      this.stableJob = undefined;
      // Drain accepted tail output before this child loses callback ownership.
      await this.output.drainBufferedOutput();
      await this.output.flushSourceOutput();
      this.output.cancelMatching();
      // Both drains can yield while stop() closes desiredRunning synchronously;
      // let its already-queued teardown own the exit instead of counting failure.
      if (!this.desiredRunning) {
        return;
      }

      await this.recoverSource(
        `stream source exited (${exit.reason}, code ${exit.exitCode ?? "none"})${exit.stderr ? `: ${exit.stderr}` : ""}`,
        exit,
      );
    });
  }

  private ownsSource(scheduleKey: string, sourceIdentity: string): boolean {
    return scheduleKey === this.scheduleKey && sourceIdentity === this.sourceIdentity;
  }

  private adoptJob(job: CronStreamJob, scheduleKey: string, sourceIdentity: string): void {
    this.job = job;
    this.scheduleKey = scheduleKey;
    this.sourceIdentity = sourceIdentity;
    this.output.updateSource(job, scheduleKey, sourceIdentity);
  }

  private enqueue(label: string, operation: () => Promise<void>): Promise<void> {
    // The owner queue outlives whichever request submitted this operation.
    return runInDetachedAsyncContext(() => {
      const result = this.opTail.then(operation, operation);
      this.opTail = result.catch((error: unknown) => {
        this.params.logger.warn(
          { jobId: this.job.id, operation: label, err: formatErrorMessage(error) },
          "cron-stream: owner operation failed",
        );
      });
      return result;
    });
  }

  private async awaitBoundedStop(stop: Promise<void>): Promise<void> {
    if (!(await settlesWithin(stop, OWNER_STOP_TIMEOUT_MS))) {
      this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
      throw new Error(`stream owner stop did not settle within ${OWNER_STOP_TIMEOUT_MS}ms`);
    }
  }

  private async spawnSource(): Promise<void> {
    if (!this.desiredRunning || this.params.scheduler.signal.aborted) {
      this.state = "stopped";
      return;
    }
    this.state = "starting";
    this.runningRequestEpoch = undefined;
    this.restartExhausted = false;
    this.restartFailure = undefined;
    if (this.scheduler.signal.aborted) {
      this.scheduler = this.params.scheduler.scope();
    }
    const outputSignal = this.output.startSource(this.scheduler);
    const requestEpoch = this.requestEpoch;
    const isCurrent = () =>
      !outputSignal.aborted &&
      this.desiredRunning &&
      requestEpoch === this.requestEpoch &&
      !this.removalRequested;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const onOutput = (channel: "stdout" | "stderr", chunk: Buffer) =>
      this.output.enqueueChunk(channel, decoders[channel].write(chunk), outputSignal);
    const endOutput = () => {
      for (const channel of ["stdout", "stderr"] as const) {
        const tail = decoders[channel].end();
        if (tail) {
          this.output.enqueueChunk(channel, tail, outputSignal);
        }
      }
    };
    const ownsPersistedJob = await this.persistState({
      streamStatus: this.consecutiveFailures > 0 ? "restarting" : "starting",
      streamError: undefined,
      streamConsecutiveFailures: this.consecutiveFailures,
      streamRestartExhausted: undefined,
    });
    if (!ownsPersistedJob || !isCurrent()) {
      this.state = "stopped";
      return;
    }

    try {
      resolveCronJobEffectiveAgentId(this.job, this.params.getDefaultAgentId?.());
    } catch (error) {
      this.desiredRunning = false;
      await this.stopOperation("disabled");
      throw error;
    }

    let run: ManagedRun;
    try {
      const assertCurrent = () => {
        if (!isCurrent()) {
          throw new Error("Stream source admission is no longer current.");
        }
      };
      if (this.job.streamSandbox) {
        if (!this.params.spawnSandboxSource) {
          throw new Error("Sandbox stream execution is unavailable; no host process was started.");
        }
        run = await this.params.spawnSandboxSource({
          job: this.job,
          assertCurrent,
          signal: this.scheduler.signal,
          onOutput,
        });
      } else {
        const supervisor = this.params.getProcessSupervisor();
        this.cleanupHostScope ??= supervisor.acquireScopeCleanup(scopeKey(this.job.id), {
          processTree: "owned-only",
        });
        run = await supervisor.spawn({
          assertCurrent,
          scopeKey: scopeKey(this.job.id),
          replaceExistingScope: true,
          mode: "child",
          argv: this.job.schedule.command,
          ...(this.job.schedule.cwd ? { cwd: this.job.schedule.cwd } : {}),
          env: markOpenClawExecEnv({ ...process.env }),
          stdinMode: "pipe-closed",
          captureOutput: false,
          onStdout: (chunk) => this.output.enqueueChunk("stdout", chunk, outputSignal),
          onStderr: (chunk) => this.output.enqueueChunk("stderr", chunk, outputSignal),
        });
      }
    } catch (error) {
      try {
        await this.releaseHostScope();
      } catch (cleanupError) {
        await this.stopOperation(
          "restart-exhausted",
          undefined,
          toErrorObject(cleanupError, "stream source startup cleanup is unconfirmed"),
        );
      }
      if (!isCurrent()) {
        this.state = "stopped";
        return;
      }
      await this.recoverSource(`stream source failed to start: ${String(error)}`);
      return;
    }

    if (!isCurrent()) {
      // Keep late-spawn custody until its workload is confirmed extinct.
      this.run = run;
      await stopCronStreamRun(run, STOP_SETTLE_TIMEOUT_MS);
      await this.releaseHostScope();
      if (this.run === run) {
        this.run = undefined;
      }
      this.state = "stopped";
      return;
    }
    this.run = run;
    this.state = "running";
    this.stableJob = this.scheduler.schedule({
      id: `${scopeKey(this.job.id)}:${this.sourceIdentity}:stable`,
      delayMs: STABLE_RUN_MS,
      run: () => this.markStable(run),
    });
    const ownsRunningJob = await this.persistState({
      streamStatus: "running",
      streamError: undefined,
      streamLastStartedAtMs: run.startedAtMs,
    });
    if (!ownsRunningJob || !isCurrent()) {
      await this.stopOperation("schedule-update");
      return;
    }
    this.runningRequestEpoch = requestEpoch;
    this.params.logger.info(
      { jobId: this.job.id, runId: run.runId },
      "cron-stream: source running",
    );
    this.output.schedulePendingIfNeeded();
    void run
      .wait()
      .then(
        (exit) => {
          endOutput();
          return this.processExited(exit, run);
        },
        (error: unknown) => {
          this.params.logger.warn(
            { jobId: this.job.id, err: formatErrorMessage(error) },
            "cron-stream: supervised wait failed",
          );
          return this.processExited(
            {
              reason: "spawn-error",
              exitCode: null,
              exitSignal: null,
              durationMs: Math.max(0, this.params.scheduler.now() - run.startedAtMs),
              stdout: "",
              stderr: "",
              timedOut: false,
              noOutputTimedOut: false,
            },
            run,
          );
        },
      )
      .catch(() => {
        // The serialized owner already records exit handling failures.
      });
  }

  private async recoverSource(message: string, exit?: RunExit): Promise<void> {
    const stable = exit !== undefined && exit.durationMs >= STABLE_RUN_MS;
    this.consecutiveFailures = stable ? 0 : boundedCounter(this.consecutiveFailures, 1);
    const exhausted = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    if (exhausted) {
      await this.output.dropPendingForTerminalStop();
      this.desiredRunning = false;
      this.state = "stopped";
      this.restartExhausted = true;
      this.restartFailure = message;
    } else {
      this.state = "backoff";
    }
    const patch: Partial<CronJobState> = {
      streamStatus: exhausted ? "error" : "restarting",
      streamError: message,
      streamConsecutiveFailures: this.consecutiveFailures,
      ...(exhausted ? { streamRestartExhausted: true } : {}),
      ...(exit ? { streamLastExitAtMs: this.params.scheduler.now() } : {}),
    };
    if (exhausted) {
      await this.persistFailure(message, patch);
      await this.stopOperation("restart-exhausted");
      return;
    }
    await this.persistState(patch);
    void this.scheduleRestart(
      stable ? 0 : errorBackoffMs(this.consecutiveFailures, this.params.retryBackoffMs),
    );
  }

  private async stopOperation(
    reason: CronStreamStopReason,
    job?: CronStreamJob,
    extinctionFailure?: Error,
  ): Promise<void> {
    this.output.cancelMatching();
    if (job) {
      const key = cronStreamScheduleKey(job.schedule, job.streamSandbox);
      const identity = sourceIdentityFor(job);
      if (
        !this.ownsSource(key, identity) ||
        (!this.restartExhausted && this.state !== "stopping")
      ) {
        this.restartExhausted = job.state.streamRestartExhausted === true;
        this.restartFailure = this.restartExhausted ? job.state.streamError : undefined;
      }
      this.adoptJob(job, key, identity);
    }
    this.state = "stopping";

    let retirementError: unknown;
    if (stopRequiresSourceRetirement(reason)) {
      const adoptRetiredIdentity = (identity: string) => {
        const retiredJob = {
          ...this.job,
          state: { ...this.job.state, streamSourceIdentity: identity },
        };
        this.adoptJob(retiredJob, this.scheduleKey, identity);
      };
      try {
        const retiredIdentity = await this.params.retireSource(
          this.job.id,
          this.scheduleKey,
          this.sourceIdentity,
        );
        if (retiredIdentity !== undefined) {
          adoptRetiredIdentity(retiredIdentity);
        }
      } catch (error) {
        if (
          error instanceof CronStreamSourceRetirementError &&
          error.retirement.jobId === this.job.id &&
          error.retirement.scheduleKey === this.scheduleKey &&
          error.retirement.previousIdentity === this.sourceIdentity
        ) {
          adoptRetiredIdentity(error.retirement.identity);
        }
        // Reconcile a known retirement before final status; the original failure still reaches the caller.
        retirementError = error;
      }
    }
    this.restartJob?.cancel();
    this.restartJob = undefined;
    this.stableJob?.cancel();
    this.stableJob = undefined;
    const outputStopState = this.output.beginStop();

    const run = this.run;
    let stopError: unknown = extinctionFailure;
    if (!extinctionFailure) {
      try {
        if (run) {
          await stopCronStreamRun(run, STOP_SETTLE_TIMEOUT_MS);
        } else {
          this.params.getProcessSupervisor().cancelScope(scopeKey(this.job.id), "manual-cancel");
        }
        await this.releaseHostScope();
        if (this.run === run) {
          this.run = undefined;
        }
      } catch (error) {
        stopError = error;
      }
    }
    await this.output.finishStop(await outputStopState);

    if (stopError !== undefined) {
      // Keep ownership while the child is still retryable; do not claim stopped.
      this.state = "stopping";
      const message = `stream source failed to stop: ${formatErrorMessage(stopError)}`;
      await this.persistFailure(message, {
        streamStatus: "error",
        streamError: message,
        streamRestartExhausted: true,
      });
      if (retirementError !== undefined) {
        throw new AggregateError(
          [retirementError, stopError],
          "stream source retirement and stop both failed",
        );
      }
      throw toErrorObject(stopError, "stream source failed to stop");
    }
    this.state = "stopped";
    const stoppedState: Partial<CronJobState> =
      reason === "trust-disabled"
        ? {
            streamStatus: "disabled",
            streamError:
              "stream sources are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
          }
        : reason === "cron-disabled"
          ? { streamStatus: "disabled", streamError: "cron is disabled" }
          : (reason === "restart-exhausted" || reason === "shutdown") && this.restartExhausted
            ? {
                streamStatus: "error",
                streamError: this.restartFailure,
                streamRestartExhausted: true,
              }
            : { streamStatus: "stopped", streamError: undefined };
    await this.persistState({
      ...stoppedState,
      ...(!this.restartExhausted ? { streamRestartExhausted: undefined } : {}),
    });
    if (retirementError !== undefined) {
      throw toErrorObject(retirementError, "stream source retirement failed");
    }
  }

  private async releaseHostScope(): Promise<void> {
    if (!this.cleanupHostScope) {
      return;
    }
    // The serialized job owner joins before any replacement can acquire this scope.
    // Keep failed cleanup custody so another start cannot bypass uncertain extinction.
    await this.awaitBoundedStop(this.cleanupHostScope());
    this.cleanupHostScope = undefined;
  }

  private scheduleRestart(delayMs: number): Promise<void> {
    return this.enqueue("schedule-restart", async () => {
      if (!this.desiredRunning || this.state !== "backoff") {
        return;
      }
      this.restartJob?.cancel();
      this.restartJob = this.scheduler.schedule({
        id: `${scopeKey(this.job.id)}:${this.sourceIdentity}:restart`,
        delayMs,
        run: () => this.restartAfterBackoff(),
      });
    });
  }

  private markStable(run: ManagedRun): Promise<void> {
    return this.enqueue("mark-stable", async () => {
      if (this.run !== run || this.state !== "running") {
        return;
      }
      this.stableJob = undefined;
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

  private restartAfterBackoff(): Promise<void> {
    return this.enqueue("restart", async () => {
      if (this.state !== "backoff" || !this.desiredRunning) {
        return;
      }
      this.restartJob?.cancel();
      this.restartJob = undefined;
      await this.spawnSource();
    });
  }

  private async recordLoss(reason: CronStreamLossReason): Promise<void> {
    if (reason === "coalesced") {
      this.coalescedBatches = boundedCounter(this.coalescedBatches, 1);
    } else {
      this.droppedBatches = boundedCounter(this.droppedBatches, 1);
    }
    try {
      const counters = {
        streamDroppedBatches: this.droppedBatches,
        streamCoalescedBatches: this.coalescedBatches,
      };
      if (this.params.updateCounters) {
        await this.params.updateCounters(this.job.id, counters);
      } else {
        await this.params.updateState(this.job.id, counters, this.scheduleKey, this.sourceIdentity);
      }
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(error) },
        "cron-stream: failed to persist loss counters",
      );
    }
  }

  private async persistState(patch: Partial<CronJobState>): Promise<boolean> {
    try {
      const result = await this.params.updateState(
        this.job.id,
        patch,
        this.scheduleKey,
        this.sourceIdentity,
      );
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
      // Only an explicit false retires ownership; diagnostics are non-authoritative.
      return true;
    }
  }

  private async persistFailure(error: string, patch: Partial<CronJobState>): Promise<void> {
    try {
      await this.params.recordFailure(
        this.job.id,
        error,
        patch,
        this.scheduleKey,
        this.sourceIdentity,
      );
    } catch (failureError) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(failureError) },
        "cron-stream: failed to persist terminal source failure",
      );
    }
  }
}

export type CronStreamOwnerSnapshot = ReturnType<CronStreamJobOwner["snapshot"]>;
