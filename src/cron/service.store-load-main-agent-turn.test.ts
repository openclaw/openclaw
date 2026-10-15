import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-main-agent-turn-" });

it("executes persisted main agentTurn jobs through ordinary session admission", async () => {
  const { storePath } = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
  await writeCronStoreSnapshot({
    storePath,
    jobs: [
      {
        id: "job-1",
        name: "shared-session turn",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Check the inbox" },
        state: {},
      },
    ],
  });
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent,
    runSessionEvent,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  try {
    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: "Check the inbox",
        job: expect.objectContaining({ id: "job-1" }),
      }),
    );
    const [job] = await cron.list({ includeDisabled: true });
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastError).toBeUndefined();
  } finally {
    cron.stop();
  }
});
