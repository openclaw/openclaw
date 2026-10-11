import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-startup-agent-work-" });

describe("ordinary agent startup catch-up", () => {
  it.each([
    {
      name: "session event",
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "Deliver the reminder" },
    },
    {
      name: "isolated agent",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check the inbox" },
    },
  ] as const)("defers an overdue $name until after Gateway startup", async (testCase) => {
    const store = await makeStorePath();
    const scheduler = createTestGatewayScheduler();
    const now = scheduler.now();
    const job: CronJob = {
      id: "overdue-agent-work",
      name: testCase.name,
      agentId: "main",
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
      sessionTarget: testCase.sessionTarget,
      wakeMode: "now",
      payload: testCase.payload,
      state: { nextRunAtMs: now - 60_000 },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler,
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob,
    });
    try {
      await cron.start();
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: now + 120_000, startupCatchupAtMs: now + 120_000 },
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
