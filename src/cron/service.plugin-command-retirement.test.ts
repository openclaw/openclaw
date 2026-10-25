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
import { projectCronRunHistoryPage } from "./run-history.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { readCronRunHistoryCandidates, readCronRunHistoryRecords } from "./store/read-only.js";
import type { CronStoredJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "openclaw-command-retire-" });
const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
const everyMs = 60_000;

/**
 * The real service, queue worker and host timer drive a private command schedule. The occurrence
 * runner is a stub because retirement belongs to the scheduler, not to the command result.
 */
async function runSchedule(
  overrides: Partial<PluginCommandSchedule>,
  ticks: number,
  deps: Pick<CronServiceDeps, "resolveSessionEventTarget"> = {},
  occurrence: Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>> = {
    status: "ok",
    summary: "occurrence",
  },
) {
  const store = await makeStorePath();
  const job = {
    id: "watch",
    name: "watch",
    agentId: "main",
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs, anchorMs: nowMs },
    sessionTarget: "session:agent:main:parent",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
      toolsAllow: ["sessions_spawn", "agents_wait"],
    },
    delivery: { mode: "none" },
    pluginCommand: pluginCommandSchedule(nowMs, overrides),
    state: { nextRunAtMs: nowMs + everyMs, pluginCommandRuns: 0 },
  } satisfies CronStoredJob;
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
    const { records } = await readCronRunHistoryCandidates(store.storePath);
    const history = projectCronRunHistoryPage(
      await readCronRunHistoryRecords(
        store.storePath,
        records.map(({ id }) => id),
      ),
      { storeKey: store.storePath },
    ).entries.map(({ status, error }) => ({ status, error }));
    return { stored, history, runIsolatedAgentJob, runSessionEvent };
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

afterEach(() => {
  resetSystemEventsForTest();
});

describe("private command schedules under the live scheduler", () => {
  it("stops waking once its final allowed attempt launches", async () => {
    const result = await runSchedule({ maxRuns: 2, deadlineAtMs: nowMs + 60 * everyMs }, 8);
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(result.runSessionEvent).not.toHaveBeenCalled();
    expect(result.stored).toMatchObject({ enabled: false });
    expect(result.stored?.state.nextRunAtMs).toBeUndefined();
    // Two launches and no skipped wake-ups after retirement.
    expect(result.history).toEqual([
      { status: "ok", error: undefined },
      { status: "ok", error: undefined },
    ]);
  });

  it("retires at the deadline with one terminal receipt and no further wake-ups", async () => {
    const result = await runSchedule({ maxRuns: 100, deadlineAtMs: nowMs + everyMs + 30_000 }, 8);
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(result.stored).toMatchObject({ enabled: false, state: { pluginCommandRuns: 1 } });
    expect(result.stored?.state.nextRunAtMs).toBeUndefined();
    expect(result.history).toEqual(
      expect.arrayContaining([
        { status: "skipped", error: "cron: plugin command schedule deadline expired" },
      ]),
    );
    expect(result.history).toHaveLength(2);
  });

  it("retires a schedule from a previous Gateway process before spending an attempt", async () => {
    const result = await runSchedule(
      { maxRuns: 100, deadlineAtMs: nowMs + 60 * everyMs, hostProcessId: "1:previous-boot" },
      8,
    );
    expect(result.runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(result.runSessionEvent).not.toHaveBeenCalled();
    expect(result.stored).toMatchObject({ enabled: false, state: { pluginCommandRuns: 0 } });
    expect(result.history).toEqual([
      { status: "skipped", error: "cron: plugin command schedule ended with its Gateway process" },
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
    const result = await runSchedule({ maxRuns: 1, deadlineAtMs: nowMs + 60 * everyMs }, 2, {
      resolveSessionEventTarget: () => ({ agentId: "main", sessionKey: "agent:main:parent" }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(result.runSessionEvent).not.toHaveBeenCalled();
    expect(result.history).toEqual([{ status: "ok", error: undefined }]);
    expect(peekSystemEventEntries(queueKey).map(({ text }) => text)).toEqual(["Parent notice"]);
  });

  it("retires on the first refusal from a replaced plugin instance, without auto-disable", async () => {
    const refused = {
      status: "error" as const,
      error:
        "Scheduled plugin command's original plugin instance was replaced; the schedule ended.",
      errorClassification: { kind: "permanent" as const },
      executionStarted: false,
    };
    const result = await runSchedule(
      { maxRuns: 100, deadlineAtMs: nowMs + 60 * everyMs },
      8,
      {},
      refused,
    );
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(result.stored).toMatchObject({ enabled: false, state: { pluginCommandRuns: 1 } });
    expect(result.stored?.state.nextRunAtMs).toBeUndefined();
    expect(result.stored?.state.autoDisabled).toBeUndefined();
    expect(result.history).toEqual([{ status: "error", error: refused.error }]);
  });

  it("keeps waking after a refusal that is not permanent", async () => {
    const result = await runSchedule(
      { maxRuns: 100, deadlineAtMs: nowMs + 60 * everyMs },
      3,
      {},
      { status: "error", error: "Scheduled plugin command source changed or expired." },
    );
    expect(result.runIsolatedAgentJob).toHaveBeenCalledTimes(3);
    expect(result.stored).toMatchObject({ enabled: true, state: { pluginCommandRuns: 3 } });
    expect(result.stored?.state.nextRunAtMs).toBeGreaterThan(nowMs);
  });
});
