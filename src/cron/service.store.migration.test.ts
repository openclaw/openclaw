import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { loadCronStore } from "./store.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-migrate-"));
  return {
    dir,
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
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
    const store = await makeStorePath();
    const atMs = 1_700_000_000_000;
    const legacyJob = {
      id: "job-1",
      agentId: undefined,
      name: "Legacy job",
      description: null,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "telegram",
        to: "7200373102",
        bestEffortDeliver: true,
      },
      isolation: { postToMainPrefix: "Cron" },
      state: {},
    };
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify({ version: 1, jobs: [legacyJob] }, null, 2));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    cron.stop();

    const loaded = await loadCronStore(store.storePath);
    const migrated = loaded.jobs[0] as Record<string, unknown>;
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

    await store.cleanup();
  });
});
