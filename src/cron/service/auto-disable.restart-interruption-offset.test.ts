import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "./jobs.js";
import { createCronServiceState, type DeferredCronNotifications } from "./state.js";
import { applyJobResult, applyTriggerNoFireResult } from "./timer-outcomes.js";

const BASE_MS = Date.parse("2026-09-16T12:00:00.000Z");
const EVERY_MS = 60_000;

function offsetState(nowMs: number) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "/tmp/auto-disable-restart-interruption-offset.json",
    cronEnabled: true,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
}

/** One restart interruption already recorded against a one-error streak. */
function interruptedJob(id: string, state: Partial<CronJob["state"]> = {}): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: BASE_MS - EVERY_MS,
    updatedAtMs: BASE_MS,
    schedule: { kind: "every", everyMs: EVERY_MS, anchorMs: BASE_MS - EVERY_MS },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: {
      nextRunAtMs: BASE_MS,
      consecutiveErrors: 1,
      consecutiveRestartInterruptions: 1,
      lastRunInterruptionReason: "gateway-restart",
      lastError: "cron: job interrupted by gateway restart",
      ...state,
    },
  };
}

/** Drives `count` genuine run failures through the real run-outcome owner. */
function runGenuineFailures(job: CronJob, count: number): void {
  const state = offsetState(BASE_MS);
  const deferredNotifications: DeferredCronNotifications = [];
  for (let failure = 0; failure < count; failure += 1) {
    const startedAt = BASE_MS + (failure + 1) * EVERY_MS;
    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider refused the request",
        executionStarted: true,
        startedAt,
        endedAt: startedAt + 500,
      },
      { deferredNotifications },
    );
  }
}

describe("restart-interruption offset reconciliation", () => {
  it("clears the offset when a quiet trigger tick clears the error streak", () => {
    const job = interruptedJob("quiet-trigger-offset");
    const endedAt = BASE_MS + 1_000;

    applyTriggerNoFireResult(
      offsetState(endedAt),
      job,
      {
        startedAt: BASE_MS,
        endedAt,
        // `busy` is `busy?: true`, so a non-busy evaluation omits it entirely.
        triggerEval: { fired: false, stateChanged: false },
      },
      { deferredNotifications: [] },
    );

    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.consecutiveRestartInterruptions).toBe(0);
  });

  it("spends the whole budget on genuine failures after a quiet trigger tick", () => {
    const job = interruptedJob("quiet-trigger-budget");
    const endedAt = BASE_MS + 1_000;
    applyTriggerNoFireResult(
      offsetState(endedAt),
      job,
      {
        startedAt: BASE_MS,
        endedAt,
        // `busy` is `busy?: true`, so a non-busy evaluation omits it entirely.
        triggerEval: { fired: false, stateChanged: false },
      },
      { deferredNotifications: [] },
    );

    // The interruption belonged to a streak the quiet tick ended, so these ten
    // failures are the job's own and must exhaust the budget on the tenth.
    runGenuineFailures(job, 10);

    expect(job.state.consecutiveErrors).toBe(10);
    expect(job.enabled).toBe(false);
    expect(job.state.autoDisabled).toMatchObject({
      reason: "consecutive-failures",
      consecutiveErrors: 10,
    });
  });

  it("clears the offset when a state patch resets the error streak", () => {
    const job = interruptedJob("patched-offset");

    applyJobPatch(job, { state: { consecutiveErrors: 0 } });

    expect(job.state.consecutiveErrors).toBe(0);
    expect(job.state.consecutiveRestartInterruptions).toBe(0);
  });

  it("clamps the offset to a shortened patched error streak", () => {
    const job = interruptedJob("patched-clamp", {
      consecutiveErrors: 5,
      consecutiveRestartInterruptions: 5,
    });

    applyJobPatch(job, { state: { consecutiveErrors: 2 } });

    expect(job.state.consecutiveRestartInterruptions).toBe(2);
  });

  it("spends the whole budget on genuine failures after a patched streak reset", () => {
    const job = interruptedJob("patched-budget");
    applyJobPatch(job, { state: { consecutiveErrors: 0 } });

    runGenuineFailures(job, 10);

    expect(job.state.consecutiveErrors).toBe(10);
    expect(job.enabled).toBe(false);
  });

  it("keeps an untouched interruption offset out of a patch that leaves the streak alone", () => {
    const job = interruptedJob("patched-unrelated");

    applyJobPatch(job, { state: { lastDurationMs: 25 } });

    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.consecutiveRestartInterruptions).toBe(1);
  });
});
