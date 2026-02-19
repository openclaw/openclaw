import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

/**
 * Regression test for https://github.com/openclaw/openclaw/issues/19300
 *
 * File-backed cron jobs that use "jobId" instead of "id" (a common convention
 * in hand-written jobs.json files) were not found by `cron run`, `cron update`,
 * or `cron remove` because `findJobOrThrow` searches by `j.id`.  The store
 * migration now normalizes `jobId` → `id` during load.
 */

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-jobid-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

async function seedStoreFile(storePath: string, store: object) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}

describe("file-backed jobs with jobId field (#19300)", () => {
  it("normalizes jobId → id so cron.run succeeds", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          jobId: "daily-standup",
          name: "Daily Standup",
          enabled: true,
          schedule: { kind: "cron", expr: "0 7 * * 1-5", tz: "America/Los_Angeles" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Run the daily standup." },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const result = await cron.run("daily-standup", "force");
      expect(result).toMatchObject({ ok: true, ran: true });
    } finally {
      cron.stop();
    }
  });

  it("normalizes jobId → id so cron.list returns proper id", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          jobId: "my-custom-id",
          name: "Test Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const jobs = await cron.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe("my-custom-id");
      expect((jobs[0] as Record<string, unknown>).jobId).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("getJob finds file-backed jobs by normalized id", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          jobId: "email-triage",
          name: "Email Triage",
          enabled: true,
          schedule: { kind: "cron", expr: "0 8-18 * * 1-5" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Triage email." },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = cron.getJob("email-triage");
      expect(job).toBeDefined();
      expect(job?.id).toBe("email-triage");
      expect(job?.name).toBe("Email Triage");
    } finally {
      cron.stop();
    }
  });

  it("generates a UUID when neither id nor jobId is present", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          name: "No ID Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const jobs = await cron.list();
      expect(jobs).toHaveLength(1);
      // Should have a generated UUID (36 chars with hyphens)
      expect(jobs[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      cron.stop();
    }
  });

  it("preserves existing id field when present", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          id: "existing-id",
          name: "Existing ID Job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const jobs = await cron.list();
      expect(jobs[0].id).toBe("existing-id");
    } finally {
      cron.stop();
    }
  });

  it("id field takes precedence when both id and jobId are present", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          id: "canonical-id",
          jobId: "legacy-id",
          name: "Both Fields",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();

    try {
      const jobs = await cron.list();
      expect(jobs[0].id).toBe("canonical-id");
      expect((jobs[0] as Record<string, unknown>).jobId).toBeUndefined();
      const result = await cron.run("canonical-id", "force");
      expect(result).toMatchObject({ ok: true, ran: true });
    } finally {
      cron.stop();
    }
  });

  it("persists normalized id back to the store file", async () => {
    const { storePath } = await makeStorePath();
    await seedStoreFile(storePath, {
      version: 1,
      jobs: [
        {
          jobId: "persisted-id",
          name: "Persist Test",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "test" },
        },
      ],
    });

    const cron = createCronService(storePath);
    await cron.start();
    cron.stop();

    // Re-read the persisted file to verify jobId was replaced with id
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(raw.jobs[0].id).toBe("persisted-id");
    expect(raw.jobs[0].jobId).toBeUndefined();
  });
});
