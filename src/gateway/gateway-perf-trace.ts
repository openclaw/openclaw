import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

/**
 * Diagnostic, env-gated request tracing for the gateway. Enable with
 * `OPENCLAW_GW_PERF=1` to append one JSON line per traced request to
 * `~/.openclaw/logs/gateway-dispatch.jsonl`. No-op otherwise, so it is safe to
 * leave the call sites in place.
 *
 * Purpose: split a slow RPC's wall-clock into received -> handler-start ->
 * handler-end -> response-sent, plus per-step marks inside heavy handlers
 * (e.g. chat.history: session entry load, model resolution, transcript read,
 * projection, byte budgeting), so the bottleneck is measured, not guessed.
 */

const GW_PERF_ENABLED = process.env.OPENCLAW_GW_PERF === "1";
const GW_PERF_LOG_PATH = `${homedir()}/.openclaw/logs/gateway-dispatch.jsonl`;

export function gwPerfEnabled(): boolean {
  return GW_PERF_ENABLED;
}

export function gwPerfNow(): number {
  return performance.now();
}

export function gwPerfLog(record: Record<string, unknown>): void {
  if (!GW_PERF_ENABLED) {
    return;
  }
  try {
    appendFileSync(GW_PERF_LOG_PATH, `${JSON.stringify({ ts: Date.now(), ...record })}\n`);
  } catch {
    // Never let diagnostics break request handling.
  }
}

// Best-effort "what handler is currently executing" so an event-loop stall can
// be blamed on the request that blocked it. With concurrent handlers this names
// the most recently entered one — good enough to spot a synchronous hog.
let gwPerfCurrentMethod = "<idle>";

export function gwPerfSetCurrentMethod(method: string): void {
  if (GW_PERF_ENABLED) {
    gwPerfCurrentMethod = method;
  }
}

// Event-loop lag sampler: a timer that should fire every 20ms; a larger gap
// means the loop was blocked by synchronous work for that long. This is what
// stalls unrelated async callbacks (e.g. chat.history's transcript-read
// resolution) and inflates their measured await time.
if (GW_PERF_ENABLED && typeof setInterval === "function") {
  const INTERVAL_MS = 20;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = now - last - INTERVAL_MS;
    last = now;
    if (lagMs >= 50) {
      gwPerfLog({ kind: "loop-lag", lagMs: Math.round(lagMs), whileRunning: gwPerfCurrentMethod });
    }
  }, INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** Accumulates per-step timings within a single handler invocation. */
export class GwPerfSteps {
  private last: number;
  private readonly start: number;
  private readonly steps: Array<[string, number]> = [];

  constructor() {
    this.start = performance.now();
    this.last = this.start;
  }

  mark(name: string): void {
    if (!GW_PERF_ENABLED) {
      return;
    }
    const now = performance.now();
    this.steps.push([name, Math.round((now - this.last) * 100) / 100]);
    this.last = now;
  }

  totalMs(): number {
    return Math.round((performance.now() - this.start) * 100) / 100;
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(this.steps);
  }
}
