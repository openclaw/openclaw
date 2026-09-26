// Cron service state tests cover in-memory scheduler state transitions.
import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState, emit } from "./state.js";

describe("cron service state", () => {
  it("defaults nowMs to the scheduler clock when not provided", () => {
    const clock = createGatewaySchedulerClock(789_000);

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(clock.clock),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      storePath: "/tmp/cron/jobs.json",
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(state.deps.nowMs()).toBe(789_000);
    expect(state.deps.defaultAgentId).toBe("main");

    clock.setTime(790_000);
    expect(state.deps.nowMs()).toBe(790_000);
  });

  it("projects store-private job provenance before emitting events", () => {
    const onEvent = vi.fn();
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storePath: "/tmp/cron/jobs.json",
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent,
    });
    const job = {
      ...makeCronJob({}),
      createdActor: { type: "human" as const, id: "profile-ada" },
    };

    emit(state, { action: "added", jobId: job.id, job });

    expect(onEvent.mock.calls[0]?.[0]?.job).not.toHaveProperty("createdActor");
  });
});
