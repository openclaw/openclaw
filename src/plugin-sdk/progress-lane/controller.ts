/**
 * Shared progress-lane ingest controller.
 *
 * Owns the body, the rolling timer, the rollover offset, and the per-stream
 * delta checkpoints; drives a channel `sink`. A channel's dispatch wires the
 * generic agent callbacks to the returned handle. Channel-neutral: the only
 * channel-specific things are the sink (render + edit primitive) and the config.
 */
import type { ProgressLaneConfig, ProgressLaneSink } from "./sink.js";
import {
  appendLaneDelta,
  appendStatusLine,
  computeSpill,
  emptyLaneStreamState,
  type LaneStreamState,
  renderLaneBody,
  resolveLaneToolLine,
  stripFinalAnswerFromBody,
} from "./transcript.js";

/** Handle the channel's dispatch wires to the generic agent callbacks. */
export interface ProgressLane {
  /** Cumulative reasoning snapshot (from `onReasoningStream`). */
  onReasoning(text: string, opts?: { replace?: boolean }): void;
  /** Intermediate assistant commentary (from `onPartialReply`); off by default. */
  onCommentary(text: string): void;
  /** Tool start (`onToolStart`); `detail` is the sanitized args/command. */
  onTool(name: string | undefined, detail?: string): void;
  /** Structured runtime event (item/plan/approval/command/patch). */
  onEvent(title: string): void;
  /** Final delivery: strip any leaked answer out of the lane, flush, stop. */
  finalize(finalText?: string): void;
  /** Tear down the timer. */
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

  let body = "";
  let renderOffset = 0;
  let reasoningState: LaneStreamState = emptyLaneStreamState();
  let commentaryState: LaneStreamState = emptyLaneStreamState();
  let prevStatusLine: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerStartedAt: number | undefined;

  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const clock = (): string => {
    const c = new Date(now());
    return `${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}`;
  };

  const flush = (): void => {
    if (!config.enabled) {
      return;
    }
    if (body.trim() === "" && timerStartedAt === undefined) {
      return; // nothing to show — never emit a bare header
    }
    const spill = computeSpill({ body, offset: renderOffset, maxChars: sink.maxChars });
    if (spill.spilled) {
      renderOffset = spill.offset;
      prevStatusLine = undefined;
      sink.spill();
    }
    const neutral = renderLaneBody({
      body: body.slice(renderOffset),
      ...(config.header !== undefined ? { header: config.header } : {}),
      ...(timerStartedAt !== undefined ? { timerStartedAt } : {}),
      now: now(),
      maxChars: sink.maxChars,
    });
    if (!neutral) {
      return;
    }
    sink.update(sink.render(neutral));
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

  const appendStatus = (line: string): void => {
    const result = appendStatusLine({
      body,
      line,
      timestamp: clock(),
      previousLine: prevStatusLine,
    });
    body = result.body;
    if (result.appendedLine !== undefined) {
      prevStatusLine = result.appendedLine;
    }
  };

  return {
    onReasoning(text, opts) {
      if (!config.enabled || !config.reasoning) {
        return;
      }
      const r = appendLaneDelta({
        body,
        state: reasoningState,
        text,
        ...(opts?.replace ? { replace: true } : {}),
      });
      body = r.body;
      reasoningState = r.state;
      flush();
    },
    onCommentary(text) {
      if (!config.enabled || !config.commentary) {
        return;
      }
      const r = appendLaneDelta({ body, state: commentaryState, text });
      body = r.body;
      commentaryState = r.state;
      flush();
    },
    onTool(name, detail) {
      if (!config.enabled || !config.toolRows) {
        return;
      }
      const line = resolveLaneToolLine({
        showArgs: config.toolArgs,
        sanitizedLine: detail,
        toolName: name,
      });
      appendStatus(line);
      armTimer();
      flush();
    },
    onEvent(title) {
      if (!config.enabled) {
        return;
      }
      appendStatus(title);
      flush();
    },
    finalize(finalText) {
      if (finalText) {
        body = stripFinalAnswerFromBody({ body, finalText });
      }
      clearTimer();
      flush();
    },
    dispose() {
      clearTimer();
    },
  };
}
