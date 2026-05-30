/**
 * Shared progress-lane ingest controller (SKELETON — sister PR to #87072).
 *
 * Owns the transcript model, the rolling timer, the spill offset, and the
 * per-stream delta checkpoints; emits `LaneSegment[]` to a channel `sink`. The
 * channel's dispatch wires the generic agent callbacks to the returned handle.
 *
 * MIGRATION: the body logic is hoisted from
 * `extensions/telegram/src/interleaved-progress.ts` (delta-append + overlap
 * dedup, `computeInterleavedSpill`, tag-strip, status-line append, final-answer
 * strip) into `./transcript.ts` (step 1 of the roadmap). Until then these
 * methods are stubs that define the shape; Telegram stays bit-identical.
 */
import type { LaneSegment, ProgressLaneConfig, ProgressLaneSink } from "./sink.js";

/** Handle the channel's dispatch wires to the generic agent callbacks. */
export interface ProgressLane {
  /** Cumulative reasoning snapshot (from `onReasoningStream`). */
  onReasoning(text: string, opts?: { replace?: boolean }): void;
  /** Intermediate assistant commentary (from `onPartialReply`, Discord-style). */
  onCommentary(text: string): void;
  /** Tool start (from `onToolStart`) — `detail` is the sanitized args/command. */
  onTool(name: string, detail?: string): void;
  /** Structured runtime event (item/plan/approval/command/patch). */
  onEvent(title: string): void;
  /** Final delivery: strip the answer out of the lane, flush, stop the timer. */
  finalize(finalText?: string): void;
  /** Tear down the timer/subscriptions. */
  dispose(): void;
}

export function createProgressLane(params: {
  sink: ProgressLaneSink;
  config: ProgressLaneConfig;
  /** Injectable clock for tests. */
  now?: () => number;
}): ProgressLane {
  const { sink, config } = params;
  const now = params.now ?? (() => Date.now());

  // --- transcript state (to be backed by ./transcript.ts) ---
  const segments: LaneSegment[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerStartedAt: number | undefined;
  // let renderOffset = 0;            // spill offset (computeInterleavedSpill)
  // let reasoningCheckpoint = ...;   // per-stream delta checkpoint

  const pad2 = (n: number): string => String(n).padStart(2, "0");

  const flush = (): void => {
    if (!config.enabled || segments.length === 0) {
      return;
    }
    // Hoist from transcript.ts — computeSpill(maxChars) → sink.spill() before render.
    let toRender: LaneSegment[] = segments;
    if (config.timer && timerStartedAt !== undefined) {
      const t = now();
      const c = new Date(t);
      toRender = [
        ...segments,
        {
          kind: "timer",
          elapsedSeconds: Math.floor((t - timerStartedAt) / 1000),
          clock: `${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}`,
        },
      ];
    }
    const rendered = sink.render(toRender);
    if (rendered) {
      sink.update(rendered);
    }
  };

  const armTimer = (): void => {
    if (!config.timer || timer) {
      return;
    }
    timerStartedAt = now();
    timer = setInterval(flush, config.timerIntervalMs);
  };

  const clearTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    timerStartedAt = undefined;
  };

  return {
    onReasoning(text) {
      if (!config.enabled || !config.reasoning) {
        return;
      }
      // Hoist from transcript.ts — tag-strip → delta-append (cumulative→suffix) → segment.
      segments.push({ kind: "reasoning", text });
      flush();
    },
    onCommentary(text) {
      if (!config.enabled || !config.commentary) {
        return;
      }
      segments.push({ kind: "reasoning", text });
      flush();
    },
    onTool(name, detail) {
      if (!config.enabled || !config.toolRows) {
        return;
      }
      segments.push({
        kind: "tool",
        name,
        ...(config.toolArgs && detail ? { detail } : {}),
      });
      armTimer();
      flush();
    },
    onEvent(title) {
      if (!config.enabled) {
        return;
      }
      segments.push({ kind: "event", title });
      flush();
    },
    finalize(_finalText) {
      // Hoist from transcript.ts — stripFinalAnswerFromBody(_finalText) → final flush.
      clearTimer();
      flush();
    },
    dispose() {
      clearTimer();
    },
  };
}
