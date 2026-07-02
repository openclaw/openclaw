import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { applyJobResult } from "./timer.js";

const noop = () => undefined;
const logger = { debug: noop, info: noop, warn: noop, error: noop };

function recurringAgentJob(): CronJob {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    id: "recurring-agent-billing",
    name: "recurring agent billing",
    enabled: true,
    createdAtMs: now - 1000,
    updatedAtMs: now - 1000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run scheduled task" },
    state: { nextRunAtMs: now },
  };
}

describe("cron recurring agent billing safety", () => {
  it("preserves existing recurring behavior for billing errors unless the guard is enabled", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const job = recurringAgentJob();
    const state = {
      deps: {
        log: logger,
      },
    } as any;

    applyJobResult(state, job, {
      status: "error",
      error: "HTTP 402: insufficient credits; fallback failed with HTTP 429 rate limit exceeded",
      startedAt,
      endedAt: startedAt + 1000,
    });

    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBe(startedAt + 31_000);
    expect(job.state.lastErrorReason).toBe("billing");
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it("schedules opt-in billing guard probes without disabling recurring agent jobs", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const job = recurringAgentJob();
    const state = {
      deps: {
        log: logger,
        cronConfig: { billingGuard: { enabled: true, probeBackoffMs: [300_000] } },
      },
    } as any;

    applyJobResult(state, job, {
      status: "error",
      error: "HTTP 402: insufficient credits; fallback failed with HTTP 429 rate limit exceeded",
      startedAt,
      endedAt: startedAt + 1000,
    });

    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBe(startedAt + 301_000);
    expect(job.state.lastErrorReason).toBe("billing");
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it("keeps existing retry/backoff behavior for rate-limit-only errors", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const job = recurringAgentJob();
    const state = {
      deps: {
        log: logger,
        cronConfig: { retry: { maxAttempts: 1, backoffMs: [1000], retryOn: ["rate_limit"] } },
      },
    } as any;

    applyJobResult(state, job, {
      status: "error",
      error: "HTTP 429: rate limit exceeded",
      startedAt,
      endedAt: startedAt + 1000,
    });

    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBe(startedAt + 2000);
    expect(job.state.lastErrorReason).toBe("rate_limit");
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it("recovers automatically after a successful billing guard probe", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const job = recurringAgentJob();
    const state = {
      deps: {
        log: logger,
        cronConfig: { billingGuard: { enabled: true, probeBackoffMs: [300_000] } },
      },
    } as any;

    applyJobResult(state, job, {
      status: "error",
      error: "HTTP 402: insufficient credits",
      startedAt,
      endedAt: startedAt + 1000,
    });

    const probeStartedAt = job.state.nextRunAtMs ?? startedAt + 301_000;
    applyJobResult(state, job, {
      status: "ok",
      startedAt: probeStartedAt,
      endedAt: probeStartedAt + 1000,
    });

    expect(job.enabled).toBe(true);
    expect(job.state.lastErrorReason).toBeUndefined();
    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.nextRunAtMs).toBe(startedAt + 360_000);
  });
});
