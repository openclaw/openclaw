import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as factsBackfill from "../config/sessions/session-transcript-facts-backfill.js";
import * as agentRuns from "../infra/agent-run-registry.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayIndependentRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as historyPrewarm from "./server-history-prewarm.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";
import * as lazyCoreHandlers from "./server-methods/lazy-core-handlers.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";
import { scheduleGatewaySessionFactsBackfill } from "./server-startup-session-migration.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
  vi.spyOn(lazyCoreHandlers, "prepareGatewayRequestHandler").mockImplementation(
    async (handler) => handler,
  );
});

afterEach(async () => {
  await scheduler.stop();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

function scheduleIdle(run: () => Promise<void>, log = { warn: vi.fn() }, retryDelayMs = 1) {
  return scheduleGatewayIdleTask({
    id: "test:idle",
    scheduler,
    delayMs: 0,
    retryDelayMs,
    isClosing: () => false,
    isBusy: () => false,
    run,
    log,
    errorMessage: "idle task failed",
  });
}

function scheduleHandler(load: () => Promise<void>, log: { warn: (message: string) => void }) {
  vi.spyOn(historyPrewarm, "prewarmGatewaySessionHistory").mockImplementation(load);
  return scheduleGatewayHandlerPrewarm({
    scheduler,
    getConfig: () => ({}),
    log,
  });
}

it.each(["complete", "shutdown"] as const)(
  "paces facts backfill outside foreground work and stops on %s",
  async (outcome) => {
    const liveRuns = vi.spyOn(agentRuns, "getActiveAgentRunContextCount").mockReturnValue(1);
    const entered = createDeferred();
    const runBatch = vi.fn(async (signal: AbortSignal) => {
      entered.resolve();
      if (outcome === "shutdown") {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(signal.aborted).toBe(true);
      }
      return outcome === "complete";
    });
    vi.spyOn(factsBackfill, "createSessionTranscriptFactsBackfill").mockReturnValue(runBatch);
    const foreground = tryBeginGatewayIndependentRootWorkAdmission("test:foreground");
    expect(foreground).not.toBeNull();
    scheduleGatewaySessionFactsBackfill({
      databases: [
        { database: { agentId: "main", path: "/synthetic/agent.sqlite" }, assertCurrent() {} },
      ],
      scheduler,
      signal: scheduler.signal,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await clock.advanceBy(250);
    expect(runBatch).not.toHaveBeenCalled();
    foreground!.release();
    await clock.advanceBy(1_000);
    expect(runBatch).not.toHaveBeenCalled();
    liveRuns.mockReturnValue(0);
    const tick = clock.advanceBy(1_000);
    await entered.promise;
    if (outcome === "shutdown") {
      await scheduler.stop();
    }
    await tick;
    expect(runBatch).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    await clock.advanceBy(60_000);
    expect(runBatch).toHaveBeenCalledOnce();
  },
);

it.each(["idle", "handler"] as const)(
  "joins started %s work before the Gateway sidecar owner closes",
  async (kind) => {
    const released = createDeferred();
    const started = createDeferred();
    const events: string[] = [];
    const run = async () => {
      events.push("started");
      started.resolve();
      await released.promise;
      events.push("finished");
    };
    const log = { warn: vi.fn() };
    const handle = kind === "idle" ? scheduleIdle(run, log) : scheduleHandler(run, log);
    const owner = createGatewaySidecarStopOwner();
    owner.publish(handle);
    let stopping: Promise<void> | undefined;
    try {
      await Promise.resolve();
      void clock.advanceBy(0);
      await started.promise;
      expect([...events]).toEqual(["started"]);
      owner.beginClose();
      stopping = owner.stop().then(() => {
        events.push("closed");
      });
      await clock.advanceBy(0);
      expect([...events]).toEqual(["started"]);
    } finally {
      owner.beginClose();
      stopping ??= owner.stop();
      released.resolve();
      await stopping;
    }
    expect(events).toEqual(["started", "finished", "closed"]);
    if (kind === "handler") {
      expect(historyPrewarm.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
      expect(lazyCoreHandlers.prepareGatewayRequestHandler).not.toHaveBeenCalled();
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it.each(["suspension", "restart signal"] as const)(
  "stops idle work without reopening the %s fence",
  async (kind) => {
    const suspension = kind === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
    const restart = kind === "restart signal" ? beginGatewayRestartSignalAdmission() : null;
    expect(suspension?.commit() ?? Boolean(restart)).toBe(true);
    const run = vi.fn(async () => {});
    const handle = scheduleIdle(run, undefined, 10);
    try {
      await clock.advanceBy(0);
      await expect(Promise.resolve(handle.stop())).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      const closing = handle.stop();
      suspension?.release();
      restart?.rollback();
      await closing;
    }
    await clock.advanceBy(10);
    expect(run).not.toHaveBeenCalled();
  },
);

it("joins the outgoing handler when shutdown begins in its warning callback", async () => {
  const events: string[] = [];
  let rootsAfterStop: number | undefined;
  let stopping: Promise<void> | undefined;
  const warn = vi.fn(() => {
    events.push("warning");
    stopping = Promise.resolve(sidecar.stop()).then(() => {
      rootsAfterStop = getActiveGatewayRootWorkCount();
      events.push("closed");
    });
  });
  const sidecar = scheduleHandler(
    async () => {
      events.push("started");
      throw new Error("cold load failed");
    },
    { warn },
  );
  await Promise.resolve();
  await clock.advanceBy(0);
  await stopping;
  expect(warn).toHaveBeenCalledOnce();
  expect(events).toEqual(["started", "warning", "closed"]);
  expect(rootsAfterStop).toBe(0);
  expect(historyPrewarm.prewarmGatewaySessionHistory).toHaveBeenCalledOnce();
  expect(lazyCoreHandlers.prepareGatewayRequestHandler).not.toHaveBeenCalled();
});
