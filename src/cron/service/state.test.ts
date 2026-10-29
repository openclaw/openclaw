// Cron service state tests cover in-memory scheduler state transitions.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState, emit, prepareCronServiceStore } from "./state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("cron service state", () => {
  it("reuses a prepared partition without enumerating the environment and reselects after a state-root change", async () => {
    const root = tempDirs.make("cron-state-preparation-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storePath: path.join(root, "explicit-partition.json"),
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    try {
      await prepareCronServiceStore(state);
      const keys = vi.spyOn(Object, "keys");
      try {
        for (let index = 0; index < 10; index++) {
          expect(prepareCronServiceStore(state)).toBeUndefined();
        }
        expect(keys.mock.calls.filter(([source]) => source === process.env)).toHaveLength(0);
      } finally {
        keys.mockRestore();
      }
      state.store = { version: 1, jobs: [] };
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("cron-state-next-"));
      const preparation = prepareCronServiceStore(state);
      expect(preparation).toBeInstanceOf(Promise);
      expect(state.store).toBeNull();
      await preparation;
      expect(state.deps.storeKey).toBe(path.join(root, "explicit-partition.json"));
      expect(prepareCronServiceStore(state)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
