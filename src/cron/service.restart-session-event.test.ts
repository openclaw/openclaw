import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { abortActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-event-restart-",
  fakeTimers: false,
});
const sessionKey = "agent:main:main";
afterEach(resetSystemEventsForTest);

it.each(["next-heartbeat", "now"] as const)(
  "records an unadopted %s event as interrupted once across restart",
  async (wakeMode) => {
    const { storePath } = await makeStorePath();
    const queued = createDeferred();
    const enqueueSystemEvent: CronServiceDeps["enqueueSystemEvent"] = (text, options) => {
      const adoption = createDeferred<boolean>();
      const remove = enqueueSystemEventWithReceipt(
        text,
        { sessionKey, contextKey: options?.contextKey },
        { onSettled: adoption.resolve },
      );
      return remove ? { accepted: true, remove, adopted: adoption.promise } : { accepted: false };
    };
    const deps: CronServiceDeps = {
      storePath,
      scheduler: createTestGatewayScheduler(),
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat: () => queued.resolve(),
      requestHeartbeatAndWait: async () => {
        queued.resolve();
        return { status: "ran", durationMs: 0 };
      },
      runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
        status: "ok",
      })),
    };
    const first = new CronService(deps);
    let replacement: CronService | undefined;
    let running: ReturnType<CronService["run"]> | undefined;
    try {
      await first.start();
      const job = await first.add({
        name: "Pending reminder",
        enabled: false,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode,
        payload: { kind: "systemEvent", text: "Synthetic reminder" },
      });
      const history = () =>
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries;
      running = first.run(job.id, "force");
      await queued.promise;
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      abortActiveCronTaskRuns();
      first.stop();
      await running;
      await first.waitForIdle();

      replacement = new CronService({ ...deps, scheduler: createTestGatewayScheduler() });
      await replacement.start();
      const interrupted = history();
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ status: "error" });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      replacement.stop();
      await replacement.waitForIdle();
      await replacement.start();
      expect(history()).toEqual(interrupted);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(deps.runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      abortActiveCronTaskRuns();
      resetSystemEventsForTest();
      first.stop();
      replacement?.stop();
      await Promise.allSettled([running, first.waitForIdle(), replacement?.waitForIdle()]);
    }
  },
);

it("records success only when the session prompt adopts the queued occurrence", async () => {
  const { storePath } = await makeStorePath();
  const queued = createDeferred();
  const cron = new CronService({
    storePath,
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent: (text, options) => {
      const adoption = createDeferred<boolean>();
      const remove = enqueueSystemEventWithReceipt(
        text,
        { sessionKey, contextKey: options?.contextKey },
        { onSettled: adoption.resolve },
      );
      return remove ? { accepted: true, remove, adopted: adoption.promise } : { accepted: false };
    },
    requestHeartbeat: () => queued.resolve(),
    runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
      status: "ok",
    })),
  });
  let running: ReturnType<CronService["run"]> | undefined;
  try {
    await cron.start();
    const job = await cron.add({
      name: "Adopted reminder",
      enabled: false,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic adopted reminder" },
    });
    running = cron.run(job.id, "force");
    await queued.promise;
    const prompt = await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey,
      isMainSession: true,
      isNewSession: false,
    });
    expect(prompt).toContain("Synthetic adopted reminder");
    await running;
    expect(
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries,
    ).toMatchObject([{ status: "ok" }]);
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  } finally {
    abortActiveCronTaskRuns();
    resetSystemEventsForTest();
    cron.stop();
    await Promise.allSettled([running, cron.waitForIdle()]);
  }
});
