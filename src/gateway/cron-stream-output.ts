import {
  markCronStreamBatchTruncated,
  resolveCronStreamBatching,
  truncateCronStreamBatch,
  type CronStreamSchedule,
} from "../cron/stream-schedule.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduledJob, GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { settlesWithin } from "../shared/settle-within.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { matchCronStreamLines } from "./cron-stream-matcher.js";
import {
  readCronStreamChunk,
  remainingCronStreamLines,
  type BufferedOutput,
  type DroppedTail,
  type StreamOutputChannel,
} from "./cron-stream-output-lines.js";

const MAX_BUFFERED_OUTPUT_SEGMENTS = 64;
// Raw intake between drains is bounded at a multiple of the batch cap so a
// normal large pipe read (Node buffers up to 64 KiB per callback) does not
// lose complete lines to OS chunk boundaries, while a stalled owner queue
// still cannot buffer unbounded output.
const INTAKE_CAP_MULTIPLIER = 4;

type InFlightBatch = {
  batch: string;
  sourceIdentity: string;
  promise: Promise<CronStreamFireDisposition>;
  handled: boolean;
};

type Log = (obj: unknown, msg?: string) => void;
type CronStreamOutputStopState = { sourceBatchLost: boolean; pendingBatchLost: boolean };
type FireOutcome = { disposition: CronStreamFireDisposition } | { error: unknown };

export type CronStreamJob = CronJob & { schedule: CronStreamSchedule };
export type CronStreamFireDisposition =
  | "fired"
  | "disabled"
  | "dropped"
  | "busy"
  | "error"
  | "not-run";
export type CronStreamLossReason = "gate-drop" | "coalesced" | "not-running" | "payload-error";
export type CronStreamOwnerState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "backoff";
export type CronStreamLogger = { info: Log; warn: Log };

type CronStreamOutputParams = {
  job: CronStreamJob;
  scheduleKey: string;
  sourceIdentity: string;
  minIntervalMs: number;
  settleTimeoutMs: number;
  scheduler: GatewaySchedulerScope;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<CronStreamFireDisposition>;
  recordLoss: (reason: CronStreamLossReason) => Promise<void>;
  enqueue: (label: string, operation: () => Promise<void>) => Promise<void>;
  requestTriggerDisabledStop: () => void;
  requestMatchFailureStop: (error: string) => void;
  getGeneration: () => number;
  getState: () => CronStreamOwnerState;
  isDesiredRunning: () => boolean;
  logger: CronStreamLogger;
};

function appendBatch(left: string | undefined, right: string, maxBytes: number): string {
  return left === undefined ? right : truncateCronStreamBatch(`${left}\n${right}`, maxBytes);
}

async function waitForInFlightBatch(
  promise: Promise<CronStreamFireDisposition>,
  timeoutMs: number,
) {
  const outcome = promise.then(
    (disposition) => ({ settled: true as const, disposition }),
    (error: unknown) => ({ settled: true as const, error }),
  );
  return (await settlesWithin(outcome, timeoutMs)) ? await outcome : { settled: false as const };
}

/** Owns one stream source's bounded output and dispatch cadence. */
export class CronStreamOutput {
  private readonly params: Omit<
    CronStreamOutputParams,
    "job" | "scheduleKey" | "sourceIdentity" | "scheduler"
  >;
  private job: CronStreamJob;
  private scheduleKey: string;
  private sourceIdentity: string;
  private scheduler: GatewaySchedulerScope;
  private matcher?: RegExp;
  private matching = new AbortController();
  private matchFailed = false;
  private quietTimer?: GatewayScheduledJob;
  private rateTimer?: GatewayScheduledJob;
  private quietEpoch = 0;
  private rateEpoch = 0;
  private bufferedOutput: BufferedOutput[] = [];
  private interruptedOutput: BufferedOutput[] = [];
  private bufferedOutputBytes = 0;
  private readonly queuedOutputDrainGenerations = new Set<number>();
  private readonly outputOverflowGenerations = new Set<number>();
  private droppedChunkTail: Record<StreamOutputChannel, DroppedTail> = {
    stdout: false,
    stderr: false,
  };
  private partialLines: Record<StreamOutputChannel, string> = { stdout: "", stderr: "" };
  private discardUntilNewline: Record<StreamOutputChannel, boolean> = {
    stdout: false,
    stderr: false,
  };
  private batch?: string;
  private pendingBatch?: string;
  private firing?: InFlightBatch;
  private nextEligibleAttemptAtMs: number;

  constructor({ job, scheduleKey, sourceIdentity, scheduler, ...params }: CronStreamOutputParams) {
    this.params = params;
    this.job = job;
    this.scheduleKey = scheduleKey;
    this.sourceIdentity = sourceIdentity;
    this.scheduler = scheduler;
    this.matcher = this.compileMatcher(job.schedule);
    this.nextEligibleAttemptAtMs = (job.state.lastRunAtMs ?? 0) + params.minIntervalMs;
  }

  updateSource(job: CronStreamJob, scheduleKey: string, sourceIdentity: string): void {
    this.job = job;
    this.scheduleKey = scheduleKey;
    this.sourceIdentity = sourceIdentity;
    this.matcher = this.compileMatcher(job.schedule);
  }

  snapshot() {
    return {
      bufferedOutputBytes: this.bufferedOutputBytes,
      bufferedOutputSegments: this.bufferedOutput.length,
    };
  }

  enqueueChunk(channel: StreamOutputChannel, chunk: string, generation: number): void {
    const state = this.params.getState();
    if (
      !chunk ||
      generation !== this.params.getGeneration() ||
      (state !== "starting" && state !== "running")
    ) {
      return;
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const remaining = maxBatchBytes * INTAKE_CAP_MULTIPLIER - this.bufferedOutputBytes;
    const accepted =
      this.outputOverflowGenerations.has(generation) ||
      remaining <= 0 ||
      this.bufferedOutput.length >= MAX_BUFFERED_OUTPUT_SEGMENTS
        ? ""
        : truncateUtf8Prefix(chunk, remaining);
    if (!accepted) {
      // The last drop wins: a terminal newline in the dropped data closes the
      // broken line, so the next accepted fragment starts a clean line.
      this.droppedChunkTail[channel] = chunk.endsWith("\n") ? "clean" : "midline";
      this.outputOverflowGenerations.add(generation);
      this.queueOutputDrain(generation);
      return;
    }
    const truncatedTail = accepted !== chunk;
    const truncatedTailContinuesLine = truncatedTail && !chunk.endsWith("\n");
    const acceptedBytes = Buffer.byteLength(accepted, "utf8");
    const precededByDrop = this.droppedChunkTail[channel];
    this.droppedChunkTail[channel] = false;
    const last = this.bufferedOutput.at(-1);
    // Never merge across a dropped gap: the gap severed the line boundary.
    if (last?.channel === channel && last.generation === generation && !precededByDrop) {
      last.chunk += accepted;
      last.truncatedTail ||= truncatedTail;
      last.truncatedTailContinuesLine ||= truncatedTailContinuesLine;
    } else {
      this.bufferedOutput.push({
        channel,
        chunk: accepted,
        generation,
        truncatedTail,
        truncatedTailContinuesLine,
        precededByDrop,
      });
    }
    this.bufferedOutputBytes += acceptedBytes;
    if (truncatedTail) {
      this.outputOverflowGenerations.add(generation);
    }
    this.queueOutputDrain(generation);
  }

  async drainBufferedOutput(generation: number): Promise<void> {
    if (generation !== this.params.getGeneration()) {
      return;
    }
    const buffered = this.bufferedOutput;
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    const overflowed = this.outputOverflowGenerations.delete(generation);
    for (const entry of buffered) {
      if (!this.params.isDesiredRunning()) {
        this.interruptedOutput.push(entry);
        continue;
      }
      if (this.params.getState() !== "running") {
        if (this.params.getState() !== "stopped") {
          await this.params.recordLoss("not-running");
        }
        continue;
      }
      await this.acceptChunk(entry);
    }
    if (overflowed && this.params.getState() === "running") {
      await this.params.recordLoss("coalesced");
    }
  }

  async flushSourceOutput(generation: number): Promise<void> {
    for (const channel of ["stdout", "stderr"] as const) {
      const partialLine = this.partialLines[channel];
      // A dropped continuation makes the retained EOF prefix indeterminate;
      // child exit must not turn that prefix into a complete matchable line.
      if (!this.discardUntilNewline[channel] && !this.droppedChunkTail[channel] && partialLine) {
        const processed = await this.acceptLine(
          partialLine.endsWith("\r") ? partialLine.slice(0, -1) : partialLine,
          generation,
          false,
        );
        if (!processed) {
          return;
        }
      }
      this.partialLines[channel] = "";
      this.discardUntilNewline[channel] = false;
      this.droppedChunkTail[channel] = false;
    }
    await this.flushBatch(generation);
  }

  async beginStop(): Promise<CronStreamOutputStopState> {
    this.rateTimer?.cancel();
    this.rateTimer = undefined;
    ++this.rateEpoch;
    const state = {
      sourceBatchLost: this.matchFailed
        ? this.batch !== undefined
        : await this.hasAcceptedSourceInput(),
      pendingBatchLost: this.pendingBatch !== undefined,
    };
    this.pendingBatch = undefined;
    this.resetSourceBuffers();
    return state;
  }

  cancelMatching(): void {
    this.matching.abort();
  }

  async finishStop(state: CronStreamOutputStopState): Promise<void> {
    if (state.sourceBatchLost) {
      await this.params.recordLoss("not-running");
    }
    if (state.pendingBatchLost) {
      await this.params.recordLoss("not-running");
    }
    const firing = this.firing;
    if (firing && !firing.handled) {
      const result = await waitForInFlightBatch(firing.promise, this.params.settleTimeoutMs);
      if (!result.settled) {
        await this.params.recordLoss("not-running");
        firing.handled = true;
      } else {
        await this.classifyFireOutcome(firing, result, true);
      }
    }
    this.firing = undefined;
  }

  async dropPendingForTerminalStop(): Promise<void> {
    this.rateTimer?.cancel();
    this.rateTimer = undefined;
    ++this.rateEpoch;
    if (this.pendingBatch === undefined) {
      return;
    }
    this.pendingBatch = undefined;
    await this.params.recordLoss("not-running");
  }

  startSource(scheduler: GatewaySchedulerScope): void {
    this.scheduler = scheduler;
    this.matching = new AbortController();
    this.matchFailed = false;
    this.resetSourceBuffers();
  }

  private resetSourceBuffers(): void {
    this.quietTimer?.cancel();
    this.quietTimer = undefined;
    ++this.quietEpoch;
    this.partialLines = { stdout: "", stderr: "" };
    this.discardUntilNewline = { stdout: false, stderr: false };
    this.droppedChunkTail = { stdout: false, stderr: false };
    this.batch = undefined;
    this.bufferedOutput = [];
    this.interruptedOutput = [];
    this.bufferedOutputBytes = 0;
    this.queuedOutputDrainGenerations.clear();
    this.outputOverflowGenerations.clear();
  }

  schedulePendingIfNeeded(generation: number): void {
    if (this.pendingBatch === undefined || this.params.getState() !== "running") {
      return;
    }
    this.schedulePendingFire(
      Math.max(0, this.nextEligibleAttemptAtMs - this.scheduler.now()),
      generation,
    );
  }

  private queueOutputDrain(generation: number): void {
    if (this.queuedOutputDrainGenerations.has(generation)) {
      return;
    }
    this.queuedOutputDrainGenerations.add(generation);
    void this.params.enqueue("output", async () => {
      try {
        await this.drainBufferedOutput(generation);
      } finally {
        this.queuedOutputDrainGenerations.delete(generation);
        const currentGeneration = this.params.getGeneration();
        if (
          this.bufferedOutput.some((entry) => entry.generation === currentGeneration) ||
          this.outputOverflowGenerations.has(currentGeneration)
        ) {
          this.queueOutputDrain(currentGeneration);
        }
      }
    });
  }

  private async acceptChunk(entry: BufferedOutput): Promise<void> {
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    // Bound raw lines independently of delivery batches so matching does not
    // depend on how pipe callbacks split the source text.
    const lines = readCronStreamChunk(
      { partialLines: this.partialLines, discardUntilNewline: this.discardUntilNewline },
      entry,
      maxBatchBytes * INTAKE_CAP_MULTIPLIER,
    );
    for (const { line, truncated, replay } of lines) {
      const processed = await this.acceptLine(line, entry.generation, truncated);
      if (replay && !this.params.isDesiredRunning()) {
        this.interruptedOutput.push({
          ...entry,
          chunk: processed ? replay.remaining : `${replay.rawLine}\n${replay.remaining}`,
          precededByDrop: false,
        });
        return;
      }
    }
  }

  private async acceptLine(line: string, generation: number, truncated: boolean): Promise<boolean> {
    if (truncated && this.matcher) {
      // A truncated prefix cannot prove the full oversized line matches: an
      // end-anchored or length-sensitive pattern would false-fire on the cut.
      // Match mode treats oversized lines as unmatched, like any other miss.
      return true;
    }
    const signal = this.matching.signal;
    let matched: boolean;
    try {
      matched = !this.matcher || (await matchCronStreamLines(this.matcher.source, [line], signal));
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      this.matchFailed = true;
      this.params.requestMatchFailureStop(
        `stream source match failed: ${formatErrorMessage(error)}; check the match expression and Gateway load, then re-enable the job`,
      );
      await this.params.recordLoss("not-running");
      return true;
    }
    if (!matched) {
      return true;
    }
    if (
      signal.aborted ||
      generation !== this.params.getGeneration() ||
      !this.params.isDesiredRunning()
    ) {
      return false;
    }
    const { batchMs, maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const renderedLine = truncated ? markCronStreamBatchTruncated(line, maxBatchBytes) : line;
    const candidate = this.batch === undefined ? renderedLine : `${this.batch}\n${renderedLine}`;
    const capped = truncateCronStreamBatch(candidate, maxBatchBytes);
    this.batch = capped;
    const quietEpoch = ++this.quietEpoch;
    if (capped !== candidate || Buffer.byteLength(capped, "utf8") >= maxBatchBytes) {
      await this.flushBatch(generation);
      return true;
    }
    this.quietTimer = this.scheduler.schedule({
      id: `cron-stream:${this.job.id}:${this.sourceIdentity}:quiet`,
      delayMs: batchMs,
      run: () => this.closeQuietBatch(generation, quietEpoch),
    });
    return true;
  }

  private closeQuietBatch(generation: number, epoch: number): Promise<void> {
    return this.params.enqueue("batch-closed", async () => {
      if (generation !== this.params.getGeneration()) {
        return;
      }
      if (this.params.getState() !== "running" || epoch !== this.quietEpoch) {
        if (
          this.params.getState() !== "stopped" &&
          epoch === this.quietEpoch &&
          this.batch !== undefined
        ) {
          this.batch = undefined;
          await this.params.recordLoss("not-running");
        }
        return;
      }
      await this.flushBatch(generation);
    });
  }

  private async flushBatch(generation: number): Promise<void> {
    this.quietTimer?.cancel();
    this.quietTimer = undefined;
    const batch = this.batch;
    this.batch = undefined;
    if (batch !== undefined) {
      await this.handleClosedBatch(batch, generation);
    }
  }

  private async handleClosedBatch(batch: string, generation: number): Promise<void> {
    // Child callbacks are generation-scoped; pending logical batches are not.
    if (generation !== this.params.getGeneration()) {
      return;
    }
    if (!this.params.isDesiredRunning() || this.params.getState() !== "running") {
      if (this.params.getState() !== "stopped") {
        await this.params.recordLoss("not-running");
      }
      return;
    }

    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const spacingRemaining = this.nextEligibleAttemptAtMs - this.scheduler.now();
    if (this.firing || spacingRemaining > 0 || this.pendingBatch !== undefined) {
      this.pendingBatch = appendBatch(this.pendingBatch, batch, maxBatchBytes);
      await this.params.recordLoss("coalesced");
      if (!this.firing) {
        this.schedulePendingFire(Math.max(0, spacingRemaining), generation);
      }
      return;
    }
    this.startFire(batch, generation);
  }

  private startFire(batch: string, generation: number): void {
    if (generation !== this.params.getGeneration()) {
      return;
    }
    if (!this.params.isDesiredRunning()) {
      void this.params.recordLoss("not-running");
      return;
    }
    const attemptStartedAtMs = this.scheduler.now();
    this.nextEligibleAttemptAtMs = attemptStartedAtMs + this.params.minIntervalMs;
    const firing: InFlightBatch = {
      batch,
      sourceIdentity: this.sourceIdentity,
      promise: this.params.fireBatch(this.job, batch, this.scheduleKey, this.sourceIdentity),
      handled: false,
    };
    this.firing = firing;
    void firing.promise.then(
      (disposition) => this.fireSettled(firing, { disposition }),
      (error: unknown) => this.fireSettled(firing, { error }),
    );
  }

  private ownsFiring(firing: InFlightBatch): boolean {
    if (firing.handled) {
      return false;
    }
    if (this.firing === firing && firing.sourceIdentity === this.sourceIdentity) {
      return true;
    }
    firing.handled = true;
    if (this.firing === firing) {
      this.firing = undefined;
    }
    return false;
  }

  private fireSettled(firing: InFlightBatch, outcome: FireOutcome): Promise<void> {
    return this.params.enqueue(
      "error" in outcome ? "fire-rejected" : "fire-completed",
      async () => {
        if (!this.ownsFiring(firing)) {
          return;
        }
        await this.classifyFireOutcome(firing, outcome, false);
        this.firing = undefined;
        this.schedulePendingIfNeeded(this.params.getGeneration());
      },
    );
  }

  private async classifyFireOutcome(
    firing: InFlightBatch,
    outcome: FireOutcome,
    stopping: boolean,
  ): Promise<void> {
    if (firing.handled) {
      return;
    }
    if ("error" in outcome) {
      this.params.logger.warn(
        { jobId: this.job.id, err: String(outcome.error) },
        `cron-stream: batch fire failed${stopping ? " during stop" : ""}`,
      );
      await this.params.recordLoss("payload-error");
      firing.handled = true;
      return;
    }
    firing.handled = true;
    const { disposition } = outcome;
    if (disposition === "fired" || disposition === "disabled") {
      // `disabled` means the batch fired and a once-trigger disabled the job.
      if (disposition === "disabled" && !stopping) {
        this.params.requestTriggerDisabledStop();
      }
      return;
    }
    if (disposition === "dropped" || disposition === "error") {
      await this.params.recordLoss(disposition === "dropped" ? "gate-drop" : "payload-error");
      return;
    }
    if (
      disposition === "busy" &&
      !stopping &&
      this.params.isDesiredRunning() &&
      this.params.getState() !== "stopped"
    ) {
      const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
      this.pendingBatch =
        this.pendingBatch === undefined
          ? firing.batch
          : appendBatch(firing.batch, this.pendingBatch, maxBatchBytes);
      return;
    }
    await this.params.recordLoss("not-running");
  }

  private schedulePendingFire(delayMs: number, generation: number): void {
    const rateEpoch = ++this.rateEpoch;
    this.rateTimer = this.scheduler.schedule({
      id: `cron-stream:${this.job.id}:${this.sourceIdentity}:retry`,
      delayMs,
      run: () => this.attemptPendingFire(generation, rateEpoch),
    });
  }

  private attemptPendingFire(generation: number, rateEpoch: number): Promise<void> {
    return this.params.enqueue("pending-fire", async () => {
      if (rateEpoch !== this.rateEpoch) {
        return;
      }
      this.rateTimer = undefined;
      if (this.pendingBatch === undefined) {
        return;
      }
      if (generation !== this.params.getGeneration()) {
        if (this.params.isDesiredRunning() && this.params.getState() === "running") {
          this.schedulePendingIfNeeded(this.params.getGeneration());
        }
        return;
      }
      const state = this.params.getState();
      if (state === "starting" || state === "backoff") {
        // The logical batch survives until the replacement child is running.
        return;
      }
      if (!this.params.isDesiredRunning()) {
        this.pendingBatch = undefined;
        if (state !== "stopped") {
          await this.params.recordLoss("not-running");
        }
        return;
      }
      if (state !== "running") {
        if (state !== "stopped") {
          this.pendingBatch = undefined;
          await this.params.recordLoss("not-running");
        }
        return;
      }
      if (this.firing) {
        return;
      }
      const spacingRemaining = this.nextEligibleAttemptAtMs - this.scheduler.now();
      if (spacingRemaining > 0) {
        this.schedulePendingFire(spacingRemaining, generation);
        return;
      }
      const pending = this.pendingBatch;
      this.pendingBatch = undefined;
      this.startFire(pending, generation);
    });
  }

  private compileMatcher(schedule: CronStreamSchedule): RegExp | undefined {
    return (schedule.mode ?? "line") === "match"
      ? (compileSafeRegex(schedule.match ?? "") ?? undefined)
      : undefined;
  }

  private async hasAcceptedSourceInput(): Promise<boolean> {
    if (this.batch !== undefined) {
      return true;
    }
    const { maxBatchBytes } = resolveCronStreamBatching(this.job.schedule);
    const remaining = remainingCronStreamLines({
      partialLines: this.partialLines,
      discardUntilNewline: this.discardUntilNewline,
      droppedChunkTail: this.droppedChunkTail,
      bufferedOutput: [...this.interruptedOutput, ...this.bufferedOutput],
      maxLineBytes: maxBatchBytes * INTAKE_CAP_MULTIPLIER,
      includeTruncated: !this.matcher,
    });
    if (!this.matcher) {
      return !remaining.next().done;
    }
    const lines = Array.from(remaining);
    if (lines.length === 0) {
      return false;
    }
    try {
      return await matchCronStreamLines(this.matcher.source, lines);
    } catch (error) {
      this.params.logger.warn(
        { jobId: this.job.id, err: formatErrorMessage(error) },
        "cron-stream: stopped output could not be classified; counting it as dropped",
      );
      return true;
    }
  }
}
