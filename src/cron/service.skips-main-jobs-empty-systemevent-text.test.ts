// Empty system event tests cover skipping main jobs with no message content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { executeJobCore } from "./service/timer-execution.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
let clock: ReturnType<typeof createGatewaySchedulerClock>;

async function withCronService(
  cronEnabled: boolean,
  run: (params: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  await withCronServiceForTest(
    {
      scheduler: createTestGatewayScheduler(clock.clock),
      makeStorePath,
      logger: noopLogger,
      cronEnabled,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    },
    run,
  );
}

describe("CronService", () => {
  beforeEach(() => {
    clock = createGatewaySchedulerClock(Date.parse("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  it("skips main jobs with empty systemEvent text", async () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(clock.clock),
      cronEnabled: true,
      storePath: "cron-empty-systemevent-test.json",
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "empty-systemevent-test",
      name: "empty systemEvent test",
      enabled: true,
      schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "   " },
      createdAtMs: clock.clock.now(),
      updatedAtMs: clock.clock.now(),
      state: {},
    };

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/non-empty/i);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("disables persisted main jobs with empty systemEvent text after skipping them", async () => {
    await withCronService(true, async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "empty systemEvent test",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "   " },
      });

      await clock.advanceTo(atMs);

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();

      const [job] = await cron.list({ includeDisabled: true });
      expect(job?.enabled).toBe(false);
      expect(job?.state.lastStatus).toBe("skipped");
      expect(job?.state.lastError).toMatch(/non-empty/i);
      expect(job?.state.nextRunAtMs).toBeUndefined();
    });
  });

  it("does not schedule timers when cron is disabled", async () => {
    await withCronService(false, async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "disabled cron job",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(false);
      expect(status.nextWakeAtMs).toBeNull();

      await clock.advanceTo(atMs);

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(noopLogger.warn).toHaveBeenCalled();
    });
  });

  it("status reports next wake when enabled", async () => {
    await withCronService(true, async ({ cron }) => {
      const atMs = Date.parse("2025-12-13T00:00:05.000Z");
      await cron.add({
        name: "status next wake",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(true);
      expect(status.jobs).toBe(1);
      expect(status.nextWakeAtMs).toBe(atMs);
    });
  });
});
