import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite();

function createCronService(storePath: string, cronEnabled = true) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

it("loads persisted jobs for direct reads without starting the scheduler", async () => {
  const { storePath } = await makeStorePath();
  const writer = createCronService(storePath);
  await writer.start();
  const persisted = await writer.add({
    name: "persisted-job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    delivery: { mode: "webhook", to: "https://example.invalid/cron" },
  });
  writer.stop();

  const reader = createCronService(storePath, false);

  await expect(reader.readJob(persisted.id)).resolves.toEqual(persisted);
  await expect(reader.readJob("missing-job-id")).resolves.toBeUndefined();
  expect(reader.getJob(persisted.id)).toEqual(persisted);
});
