import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2026-02-06T17:00:00.000Z",
});

function createStartedCron(storePath: string) {
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  });
  return {
    cron,
    start: async () => {
      await cron.start();
      return cron;
    },
  };
}

async function listJobById(cron: CronService, jobId: string) {
  const jobs = await cron.list({ includeDisabled: true });
  return jobs.find((entry) => entry.id === jobId);
}

async function startCronWithStoredJobs(jobs: Array<Record<string, unknown>>) {
  const store = await makeStorePath();
  await fs.mkdir(path.dirname(store.storePath), { recursive: true });
  await fs.writeFile(
    store.storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
  const cron = await createStartedCron(store.storePath).start();
  return { store, cron };
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  cron.stop();
  await store.cleanup();
}

function createLegacyIsolatedAgentTurnJob(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    enabled: true,
    createdAtMs: Date.parse("2026-02-01T12:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-05T12:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 23 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "legacy payload fields" },
    ...overrides,
  };
}

describe("CronService store migrations", () => {
  it("migrates legacy top-level agentTurn fields and initializes missing state", async () => {
    const { store, cron } = await startCronWithStoredJobs([
      createLegacyIsolatedAgentTurnJob({
        id: "legacy-agentturn-job",
        name: "legacy agentturn",
        model: "openrouter/deepseek/deepseek-r1",
        thinking: "high",
        timeoutSeconds: 120,
        allowUnsafeExternalContent: true,
        deliver: true,
        channel: "telegram",
        to: "12345",
        bestEffortDeliver: true,
      }),
    ]);

    const status = await cron.status();
    expect(status.enabled).toBe(true);

    const job = await listJobById(cron, "legacy-agentturn-job");
    expect(job).toBeDefined();
    expect(job?.state).toBeDefined();
    expect(job?.sessionTarget).toBe("isolated");
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.model).toBe("openrouter/deepseek/deepseek-r1");
      expect(job.payload.thinking).toBe("high");
      expect(job.payload.timeoutSeconds).toBe(120);
      expect(job.payload.allowUnsafeExternalContent).toBe(true);
    }
    expect(job?.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "12345",
      bestEffort: true,
    });

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs.find((entry) => entry.id === "legacy-agentturn-job");
    expect(persistedJob).toBeDefined();
    expect(persistedJob?.state).toEqual(expect.any(Object));
    expect(persistedJob?.model).toBeUndefined();
    expect(persistedJob?.thinking).toBeUndefined();
    expect(persistedJob?.timeoutSeconds).toBeUndefined();
    expect(persistedJob?.deliver).toBeUndefined();
    expect(persistedJob?.channel).toBeUndefined();
    expect(persistedJob?.to).toBeUndefined();
    expect(persistedJob?.bestEffortDeliver).toBeUndefined();

    await stopCronAndCleanup(cron, store);
  });

  it("preserves legacy timeoutSeconds=0 during top-level agentTurn field migration", async () => {
    const { store, cron } = await startCronWithStoredJobs([
      createLegacyIsolatedAgentTurnJob({
        id: "legacy-agentturn-no-timeout",
        name: "legacy no-timeout",
        timeoutSeconds: 0,
      }),
    ]);

    const job = await listJobById(cron, "legacy-agentturn-no-timeout");
    expect(job).toBeDefined();
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.timeoutSeconds).toBe(0);
    }

    await stopCronAndCleanup(cron, store);
  });

  it("migrates legacy cron fields (jobId + schedule.cron) and defaults wakeMode", async () => {
    const { store, cron } = await startCronWithStoredJobs([
      {
        jobId: "legacy-cron-field-job",
        name: "legacy cron field",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T12:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-05T12:00:00.000Z"),
        schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
    ]);
    const job = await listJobById(cron, "legacy-cron-field-job");
    expect(job).toBeDefined();
    expect(job?.wakeMode).toBe("now");
    expect(job?.schedule.kind).toBe("cron");
    if (job?.schedule.kind === "cron") {
      expect(job.schedule.expr).toBe("*/5 * * * *");
    }

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs.find((entry) => entry.id === "legacy-cron-field-job");
    expect(persistedJob).toBeDefined();
    expect(persistedJob?.jobId).toBeUndefined();
    expect(persistedJob?.wakeMode).toBe("now");
    const persistedSchedule =
      persistedJob?.schedule && typeof persistedJob.schedule === "object"
        ? (persistedJob.schedule as Record<string, unknown>)
        : null;
    expect(persistedSchedule?.cron).toBeUndefined();
    expect(persistedSchedule?.expr).toBe("*/5 * * * *");

    await stopCronAndCleanup(cron, store);
  });
});
