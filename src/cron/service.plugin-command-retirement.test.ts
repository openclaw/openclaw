import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import {
  enqueueAutomationSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { pluginCommandSchedule } from "./plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "./plugin-command-schedule.types.js";
import type { PluginCommandSchedule } from "./plugin-command-schedule.types.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { cronStoreKey } from "./store/key.js";
import type { CronStoredJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "openclaw-command-retire-" });
const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
const everyMs = 60_000;

// Real service/queue/timer; only the occurrence runner is stubbed.
async function runSchedule(
  overrides: Partial<PluginCommandSchedule> = {},
  ticks = 8,
  deps: Pick<CronServiceDeps, "resolveSessionEventTarget"> = {},
  occurrence: Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>> = {
    status: "ok",
    summary: "occurrence",
  },
) {
  const store = await makeStorePath();
  const job: CronStoredJob = {
    ...cronTestJob({
      id: "watch",
      agentId: "main",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "every", everyMs, anchorMs: nowMs },
      sessionTarget: "session:agent:main:parent",
      payload: {
        kind: "agentTurn",
        message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
        toolsAllow: ["sessions_spawn", "agents_wait"],
      },
      delivery: { mode: "none" },
      state: { nextRunAtMs: nowMs + everyMs, pluginCommandRuns: 0 },
    }),
    pluginCommand: pluginCommandSchedule(nowMs, {
      maxRuns: 100,
      deadlineAtMs: nowMs + 60 * everyMs,
      ...overrides,
    }),
  };
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
  const clock = createGatewaySchedulerClock(nowMs);
  const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
    ...occurrence,
  }));
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
    status: "ok" as const,
  }));
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runSessionEvent,
    runIsolatedAgentJob,
    ...deps,
  });
  try {
    await cron.start();
    for (let tick = 1; tick <= ticks; tick += 1) {
      await clock.advanceTo(nowMs + tick * everyMs + 5);
      // One real scheduler-worker tick and its launcher per elapsed interval.
      await onTimer(state);
      await waitForCronRunQueue(state);
    }
    const stored = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    const history = readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(store.storePath),
    }).entries.map(({ status, error }) => ({ status, error }));
    return { stored, history, runIsolatedAgentJob, runSessionEvent };
  } finally {
    cron.stop();
  }
}

afterEach(() => {
  resetSystemEventsForTest();
});

describe("private command schedules under the live scheduler", () => {
  it.each([
    ["attempt limit", { maxRuns: 2 }, 2, undefined],
    [
      "deadline",
      { deadlineAtMs: nowMs + everyMs + 30_000 },
      1,
      "cron: plugin command schedule deadline expired",
    ],
    [
      "previous Gateway process",
      { hostProcessId: "1:previous-boot" },
      0,
      "cron: plugin command schedule ended with its Gateway process",
    ],
  ] as const)("retires at %s without further wake-ups", async (_name, overrides, runs, error) => {
    const result = await runSchedule(overrides);
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(runs);
    expect(result.runSessionEvent).not.toHaveBeenCalled();
    expect(result.stored).toMatchObject({ enabled: false, state: { pluginCommandRuns: runs } });
    expect(result.stored?.state.nextRunAtMs).toBeUndefined();
    expect(result.history).toEqual([
      ...Array.from({ length: runs }, () => ({ status: "ok", error: undefined })),
      ...(error ? [{ status: "skipped", error }] : []),
    ]);
  });

  it("leaves the parent session's pending automation notices to the parent", async () => {
    // A command occurrence never prepares the session-event prompt route, so it must not lease,
    // consume or fail on notices queued for its parent conversation.
    const queueKey = resolveSystemEventQueueKey("agent:main:parent", "main");
    const prepare = vi.fn(async () => {
      throw new Error("a command occurrence leased the parent's automation notice");
    });
    expect(
      enqueueAutomationSystemEvent(
        "Parent notice",
        { sessionKey: queueKey },
        { jobId: "watch", assertCurrent: () => {}, prepare },
      ),
    ).toBe("queued");
    const result = await runSchedule({ maxRuns: 1 }, 2, {
      resolveSessionEventTarget: () => ({ agentId: "main", sessionKey: "agent:main:parent" }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(result.runSessionEvent).not.toHaveBeenCalled();
    expect(result.history).toEqual([{ status: "ok", error: undefined }]);
    expect(peekSystemEventEntries(queueKey).map(({ text }) => text)).toEqual(["Parent notice"]);
  });

  it.each([true, false])("retires permanent refusals only (%s)", async (permanent) => {
    const refused = {
      status: "error" as const,
      error: "refused",
      ...(permanent
        ? { errorClassification: { kind: "permanent" as const }, executionStarted: false }
        : {}),
    };
    const { stored, history, runIsolatedAgentJob: runJob } = await runSchedule({}, 3, {}, refused);
    const runs = permanent ? 1 : 3;
    expect(runJob).toHaveBeenCalledTimes(runs);
    expect(stored).toMatchObject({ enabled: !permanent, state: { pluginCommandRuns: runs } });
    if (permanent) {
      expect(stored?.state.nextRunAtMs).toBeUndefined();
      expect(stored?.state.autoDisabled).toBeUndefined();
      expect(history).toEqual([{ status: "error", error: "refused" }]);
    } else {
      expect(stored?.state.nextRunAtMs).toBeGreaterThan(nowMs);
    }
  });
});
