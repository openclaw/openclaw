import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: Record<string, unknown>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs: [job],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createStoreTestState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function createReloadCronJob(params?: Partial<CronJob>): CronJob {
  return {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: STORE_TEST_NOW - 60_000,
    updatedAtMs: STORE_TEST_NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...params,
  };
}

describe("cron service store seam coverage", () => {
  it("loads stored jobs, recomputes next runs, and does not rewrite the store on load", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "modern-job",
      name: "modern job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    expect(job).toBeDefined();
    expect(job?.sessionTarget).toBe("isolated");
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs[0];
    expect(persistedJob?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    expect(persistedJob?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const firstMtime = state.storeFileMtimeMs;
    expect(typeof firstMtime).toBe("number");

    await persist(state);
    expect(typeof state.storeFileMtimeMs).toBe("number");
    expect((state.storeFileMtimeMs ?? 0) >= (firstMtime ?? 0)).toBe(true);
  });

  it("normalizes jobId-only jobs in memory so scheduler lookups resolve by stable id", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      jobId: "repro-stable-id",
      name: "handed",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ storePath, jobId: "repro-stable-id" }),
      expect.stringContaining("legacy jobId"),
    );

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();

    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(raw.jobs[0]?.jobId).toBe("repro-stable-id");
    expect(raw.jobs[0]?.id).toBeUndefined();
  });

  it("preserves disabled jobs when persisted booleans roundtrip through string values", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "disabled-string-job",
      name: "disabled string job",
      enabled: "false",
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const before = await fs.readFile(storePath, "utf8");
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "disabled-string-job");
    expect(job.enabled).toBe(false);

    const after = await fs.readFile(storePath, "utf8");
    expect(after).toBe(before);
  });

  it("loads persisted jobs with unsafe custom session ids so run paths can fail closed", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "unsafe-session-target-job",
      name: "unsafe session target job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:../../outside",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state, { skipRecompute: true });

    const job = findJobOrThrow(state, "unsafe-session-target-job");
    expect(job.sessionTarget).toBe("session:../../outside");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ storePath, jobId: "unsafe-session-target-job" }),
      expect.stringContaining("invalid persisted sessionTarget"),
    );
  });

  it("clears stale nextRunAtMs after force reload when cron schedule expression changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await writeSingleJobStore(storePath, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when cron schedule key order changes only", async () => {
    const { storePath } = await makeStorePath();
    const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    await writeSingleJobStore(storePath, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("drops force-reloaded jobs with unrecoverable malformed schedules", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
      schedule: "0 17 * * *",
    });

    await expect(ensureLoaded(state, { forceReload: true, skipRecompute: true })).resolves.toBe(
      undefined,
    );

    expect(state.store?.jobs.map((job) => job.id)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "reload-cron-expr-job", index: 0 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
  });

  it("recovers legacy persisted jobs with top-level schedule and payload fields", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "legacy-top-level-job",
      name: "legacy top level job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      expr: "15 9 * * *",
      tz: "UTC",
      text: "daily ping",
      state: {},
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.store?.jobs).toHaveLength(1);
    expect(state.store?.jobs[0]).toEqual(
      expect.objectContaining({
        id: "legacy-top-level-job",
        schedule: { kind: "cron", expr: "15 9 * * *", tz: "UTC" },
        payload: { kind: "systemEvent", text: "daily ping" },
      }),
    );
  });

  it("ignores malformed persisted jobs instead of keeping dashboard-breaking rows", async () => {
    const { storePath } = await makeStorePath();

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            createReloadCronJob({ id: "valid-job" }),
            {
              id: "missing-schedule-job",
              name: "missing schedule job",
              enabled: true,
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "kind-only-cron-job",
              name: "kind only cron job",
              enabled: true,
              schedule: { kind: "cron" },
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "kind-only-every-job",
              name: "kind only every job",
              enabled: true,
              schedule: { kind: "every" },
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "kind-only-at-job",
              name: "kind only at job",
              enabled: true,
              schedule: { kind: "at" },
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
            {
              id: "missing-payload-job",
              name: "missing payload job",
              enabled: true,
              schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
              state: {},
            },
            {
              id: "missing-agent-message-job",
              name: "missing agent message job",
              enabled: true,
              schedule: { kind: "cron", expr: "30 6 * * *", tz: "UTC" },
              payload: { kind: "agentTurn" },
              state: {},
            },
            {
              id: "missing-system-text-job",
              name: "missing system text job",
              enabled: true,
              schedule: { kind: "cron", expr: "45 6 * * *", tz: "UTC" },
              payload: { kind: "systemEvent" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.store?.jobs.map((job) => job.id)).toEqual(["valid-job"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "missing-schedule-job", index: 1 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "kind-only-cron-job", index: 2 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "kind-only-every-job", index: 3 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "kind-only-at-job", index: 4 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "missing-payload-job", index: 5 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "missing-agent-message-job", index: 6 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "missing-system-text-job", index: 7 }),
      expect.stringContaining("ignoring malformed persisted job"),
    );

    await persist(state);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(persisted.jobs.map((job) => job.id)).toEqual([
      "valid-job",
      "missing-schedule-job",
      "kind-only-cron-job",
      "kind-only-every-job",
      "kind-only-at-job",
      "missing-payload-job",
      "missing-agent-message-job",
      "missing-system-text-job",
    ]);
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storePath } = await makeStorePath();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({ state: { nextRunAtMs: originalNextRunAtMs } }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(
      originalNextRunAtMs + 60_000,
    );
  });

  it("clears stale nextRunAtMs after force reload when enabled state changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        enabled: true,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        enabled: false,
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when every schedule anchor changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-every-anchor-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when at schedule target changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-at-target-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });
});
