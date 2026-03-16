import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-get-job-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
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

      expect(cron.getJob(added.id)?.id).toBe(added.id);
      expect(cron.getJob("missing-job-id")).toBeUndefined();
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
      expect(cron.getJob(webhookJob.id)?.delivery).toEqual({
        mode: "webhook",
        to: "https://example.invalid/cron",
      });
    } finally {
      cron.stop();
    }
  });

  it("preserves deprecated notify flag on create for legacy webhook fallback", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const legacyJob = await cron.add({
        name: "legacy-notify-job",
        enabled: true,
        notify: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });
      expect(cron.getJob(legacyJob.id)?.notify).toBe(true);
    } finally {
      cron.stop();
    }
  });

  it("rejects invalid webhook delivery target on create", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      await expect(
        cron.add({
          name: "webhook-job-invalid",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
          delivery: { mode: "webhook", to: "not-a-url" },
        }),
      ).rejects.toThrow("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    } finally {
      cron.stop();
    }
  });
});
