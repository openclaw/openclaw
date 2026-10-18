import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger });

it("preserves a job edited after its removal revision was reviewed", async () => {
  const store = await makeStorePath();
  const job: CronJob = {
    id: "claw-schedule",
    name: "Claw schedule",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Daily report" },
    delivery: { mode: "none" },
    state: {},
  };
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [job] });
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  try {
    const reviewedRevision = resolveCronJobConfigRevision(job);
    const edited = await cron.update(job.id, { name: "Operator schedule" });

    await expect(cron.remove(job.id, { expectedConfigRevision: reviewedRevision })).rejects.toThrow(
      "no longer matches the loaded version",
    );
    expect((await cron.readJob(job.id))?.name).toBe("Operator schedule");

    await expect(
      cron.remove(job.id, { expectedConfigRevision: resolveCronJobConfigRevision(edited) }),
    ).resolves.toEqual({ ok: true, removed: true });
    expect(await cron.readJob(job.id)).toBeUndefined();
  } finally {
    cron.stop();
  }
});
