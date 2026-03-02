import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import { loadCronStore } from "./store.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-migrate-" });

async function writeLegacyStore(storePath: string, legacyJob: Record<string, unknown>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [legacyJob] }, null, 2));
}

async function migrateAndLoadFirstJob(storePath: string): Promise<Record<string, unknown>> {
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });

  await cron.start();
  cron.stop();

  const loaded = await loadCronStore(storePath);
  return loaded.jobs[0] as Record<string, unknown>;
}

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    agentId: undefined,
    name: "Legacy job",
    description: null,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    state: {},
    ...overrides,
  };
}

async function migrateLegacyJob(legacyJob: Record<string, unknown>) {
  const store = await makeStorePath();
  try {
    await writeLegacyStore(store.storePath, legacyJob);
    return await migrateAndLoadFirstJob(store.storePath);
  } finally {
    await store.cleanup();
  }
}

describe("cron store migration", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("migrates isolated jobs to announce delivery and drops isolation", async () => {
    const atMs = 1_700_000_000_000;
    const migrated = await migrateLegacyJob(
      makeLegacyJob({
        id: "job-1",
        sessionKey: "  agent:main:discord:channel:ops  ",
        schedule: { kind: "at", atMs },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "hi",
          deliver: true,
          channel: "telegram",
          to: "7200373102",
          bestEffortDeliver: true,
        },
        isolation: { postToMainPrefix: "Cron" },
      }),
    );
    expect(migrated.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(migrated.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "7200373102",
      bestEffort: true,
    });
    expect("isolation" in migrated).toBe(false);

    const payload = migrated.payload as Record<string, unknown>;
    expect(payload.deliver).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.bestEffortDeliver).toBeUndefined();

    const schedule = migrated.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(atMs).toISOString());
  });

  it("adds anchorMs to legacy every schedules", async () => {
    const createdAtMs = 1_700_000_000_000;
    const migrated = await migrateLegacyJob(
      makeLegacyJob({
        id: "job-every-legacy",
        name: "Legacy every",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "every", everyMs: 120_000 },
      }),
    );
    const schedule = migrated.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("every");
    expect(schedule.anchorMs).toBe(createdAtMs);
  });

  it("adds default staggerMs to legacy recurring top-of-hour cron schedules", async () => {
    const createdAtMs = 1_700_000_000_000;
    const migrated = await migrateLegacyJob(
      makeLegacyJob({
        id: "job-cron-legacy",
        name: "Legacy cron",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
      }),
    );
    const schedule = migrated.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("adds default staggerMs to legacy 6-field top-of-hour cron schedules", async () => {
    const createdAtMs = 1_700_000_000_000;
    const migrated = await migrateLegacyJob(
      makeLegacyJob({
        id: "job-cron-seconds-legacy",
        name: "Legacy cron seconds",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "cron", expr: "0 0 */3 * * *", tz: "UTC" },
      }),
    );
    const schedule = migrated.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", async () => {
    const migrated = await migrateLegacyJob(
      makeLegacyJob({
        id: "job-cron-minute-legacy",
        name: "Legacy minute cron",
        schedule: {
          kind: "cron",
          expr: "17 * * * *",
          tz: "UTC",
          staggerMs: "bogus",
        },
      }),
    );
    const schedule = migrated.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });
});
