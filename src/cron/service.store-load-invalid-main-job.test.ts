import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-invalid-main-" });

it("skips invalid main jobs with agentTurn payloads loaded from disk", async () => {
  const { storePath } = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  await writeCronStoreSnapshot({
    storePath,
    jobs: [
      {
        id: "job-1",
        name: "bad",
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "bad" },
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
    requestHeartbeat,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  try {
    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    const [job] = await cron.list({ includeDisabled: true });
    expect(job?.state.lastStatus).toBe("skipped");
    expect(job?.state.lastError).toMatch(/main cron jobs require payload\.kind/i);
  } finally {
    cron.stop();
  }
});
