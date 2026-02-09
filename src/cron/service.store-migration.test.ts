import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService store migrations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T17:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("migrates legacy top-level agentTurn fields and initializes missing state", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy-agentturn-job",
              name: "legacy agentturn",
              enabled: true,
              createdAtMs: Date.parse("2026-02-01T12:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-05T12:00:00.000Z"),
              schedule: { kind: "cron", expr: "0 23 * * *", tz: "UTC" },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              model: "openrouter/deepseek/deepseek-r1",
              thinking: "high",
              timeoutSeconds: 120,
              allowUnsafeExternalContent: true,
              deliver: true,
              channel: "telegram",
              to: "12345",
              bestEffortDeliver: true,
              payload: { kind: "agentTurn", message: "legacy payload fields" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok", summary: "ok" })),
    });

    await cron.start();

    const status = await cron.status();
    expect(status.enabled).toBe(true);

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((entry) => entry.id === "legacy-agentturn-job");
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

    cron.stop();
    await store.cleanup();
  });
});
