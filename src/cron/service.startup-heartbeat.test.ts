import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  requestHeartbeatAndWait as requestQueuedHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../infra/heartbeat-wake.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { CronService } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { getSuspensionVisibleCronTaskRunCount } from "./service/active-run-cancellation.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-startup-heartbeat-",
  baseTimeIso: "2026-09-18T00:00:00.000Z",
});

describe("heartbeat startup catch-up", () => {
  it("records a handler-unavailable non-outcome for an early heartbeat run", async () => {
    const store = await makeStorePath();
    setHeartbeatWakeHandler(null);
    const entered = createDeferred<{ result: Promise<HeartbeatRunResult> }>();
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger,
      resolveHeartbeatTimeoutMs: () => undefined,
      requestHeartbeatAndWait: (wake, lifecycle) => {
        const result = requestQueuedHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle);
        entered.resolve({ result });
        return result;
      },
    });
    await cron.start();
    const added = await cron.add(
      {
        declarationKey: "heartbeat:main",
        name: "early heartbeat",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "heartbeat" },
      },
      { enabledExplicit: true, systemOwned: true },
    );
    const job = "job" in added ? added.job : added;
    const running = cron.run(job.id, "force");
    try {
      const { result } = await entered.promise;
      expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({
        status: "skipped",
        reason: "handler-unavailable",
      });
      await running;
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: "heartbeat skipped: handler-unavailable",
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
    } finally {
      const dispose = setHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.advanceTimersByTimeAsync(250);
      await running;
      cron.stop();
      dispose();
      await store.cleanup();
    }
  });

  it.each([
    { name: "monitor", declarationKey: "heartbeat:main", payload: { kind: "heartbeat" } },
    {
      name: "task",
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      payload: { kind: "systemEvent", text: "Check the inbox" },
    },
    { name: "immediate event", payload: { kind: "systemEvent", text: "Deliver the reminder" } },
  ] as const)("defers an overdue $name without awaiting its heartbeat", async (testCase) => {
    const store = await makeStorePath();
    const now = Date.now();
    const job: CronJob = {
      id: "overdue-heartbeat",
      name: testCase.name,
      ...("declarationKey" in testCase ? { declarationKey: testCase.declarationKey } : {}),
      agentId: "main",
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: "main",
      wakeMode: testCase.name === "immediate event" ? "now" : "next-heartbeat",
      payload: testCase.payload,
      state: { nextRunAtMs: now - 60_000 },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const entered = createDeferred<"heartbeat">();
    const release = createDeferred<HeartbeatRunResult>();
    const requestHeartbeatAndWait = vi.fn(async () => {
      entered.resolve("heartbeat");
      return await release.promise;
    });
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      requestHeartbeatAndWait,
      resolveHeartbeatTimeoutMs: () => undefined,
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const starting = cron.start();
    try {
      expect(await Promise.race([starting.then(() => "started"), entered.promise])).toBe("started");
      expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: now + 120_000, startupCatchupAtMs: now + 120_000 },
      });
    } finally {
      release.resolve({ status: "skipped", reason: "disabled" });
      await starting;
      cron.stop();
      await store.cleanup();
    }
  });
});
