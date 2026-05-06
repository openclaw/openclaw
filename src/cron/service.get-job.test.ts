import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-get-job-" });
installCronTestHooks({ logger });

function createCronService(storePath: string, cronEnabled = true) {
  return new CronService({
    storePath,
    cronEnabled,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService.getJob", () => {
  it("returns added jobs and undefined for missing ids", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add({
        name: "lookup-test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });

      await expect(cron.getJob(added.id)).resolves.toEqual(
        expect.objectContaining({ id: added.id }),
      );
      await expect(cron.getJob("missing-job-id")).resolves.toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("preserves webhook delivery on create", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const webhookJob = await cron.add({
        name: "webhook-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      });
      await expect(cron.getJob(webhookJob.id)).resolves.toEqual(
        expect.objectContaining({
          delivery: {
            mode: "webhook",
            to: "https://example.invalid/cron",
          },
        }),
      );
    } finally {
      cron.stop();
    }
  });

  it("loads persisted jobs when the scheduler is disabled", async () => {
    const { storePath } = await makeStorePath();
    const persistedJob: CronJob = {
      id: "persisted-disabled-job",
      name: "persisted disabled job",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "ping" },
      state: {},
    };
    await writeCronStoreSnapshot({ storePath, jobs: [persistedJob] });
    const cron = createCronService(storePath, false);
    await cron.start();

    try {
      await expect(cron.getJob(persistedJob.id)).resolves.toEqual(
        expect.objectContaining({
          id: persistedJob.id,
          name: persistedJob.name,
        }),
      );
    } finally {
      cron.stop();
    }
  });

  it("keeps synchronous loaded-job peeks for already-loaded event paths", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const webhookJob = await cron.add({
        name: "peek-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      });
      expect(cron.peekLoadedJob(webhookJob.id)?.delivery).toEqual({
        mode: "webhook",
        to: "https://example.invalid/cron",
      });
    } finally {
      cron.stop();
    }
  });
});
