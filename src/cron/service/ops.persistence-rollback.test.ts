// Cron persistence rollback tests cover CRUD retries after transient store failures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronJobCreate } from "../types.js";
import { add, readJob, remove, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const persistFailure = vi.hoisted(() => ({ remaining: 0 }));

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    persist: vi.fn(async (...args: Parameters<typeof actual.persist>) => {
      if (persistFailure.remaining > 0) {
        persistFailure.remaining -= 1;
        throw new Error("forced cron persist failure");
      }
      return await actual.persist(...args);
    }),
  };
});

const nowMs = Date.parse("2026-02-06T10:00:00.000Z");

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: false,
    log: logger,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function createInput(id = "durable-job"): CronJobCreate {
  return {
    id,
    name: "durable job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function createPersistedJob(id = "durable-job"): CronJob {
  return {
    ...createInput(id),
    id,
    enabled: true,
    createdAtMs: nowMs - 60_000,
    updatedAtMs: nowMs - 60_000,
    state: { nextRunAtMs: nowMs + 60_000 },
  };
}

afterEach(() => {
  persistFailure.remaining = 0;
  vi.clearAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("cron persistence failure rollback", () => {
  it("does not expose a volatile job after add persistence fails", async () => {
    await withOpenClawTestState({ prefix: "cron-add-rollback-" }, async (stateDir) => {
      const storePath = stateDir.statePath("cron", "jobs.json");
      const state = createState(storePath);

      persistFailure.remaining = 1;
      await expect(add(state, createInput())).rejects.toThrow("forced cron persist failure");

      await expect(readJob(state, "durable-job")).resolves.toBeUndefined();
      await expect(loadCronStore(storePath)).resolves.toMatchObject({ jobs: [] });
    });
  });

  it("rejects reserved ids that collide after normalization", async () => {
    await withOpenClawTestState({ prefix: "cron-add-normalized-id-collision-" }, async (stateDir) => {
      const storePath = stateDir.statePath("cron", "jobs.json");
      const state = createState(storePath);

      await add(state, createInput("durable-job"));
      await expect(add(state, createInput(" durable-job "))).rejects.toThrow(
        "cron job already exists: durable-job",
      );
      await expect(loadCronStore(storePath)).resolves.toMatchObject({
        jobs: [{ id: "durable-job" }],
      });
    });
  });

  it("rejects blank reserved ids instead of generating a random id", async () => {
    await withOpenClawTestState({ prefix: "cron-add-blank-id-" }, async (stateDir) => {
      const storePath = stateDir.statePath("cron", "jobs.json");
      const state = createState(storePath);

      await expect(add(state, createInput("   "))).rejects.toThrow("cron job id must not be blank");
      await expect(loadCronStore(storePath)).resolves.toMatchObject({ jobs: [] });
    });
  });

  it("retries updates against the last persisted job after persistence fails", async () => {
    await withOpenClawTestState({ prefix: "cron-update-rollback-" }, async (stateDir) => {
      const storePath = stateDir.statePath("cron", "jobs.json");
      await saveCronStore(storePath, { version: 1, jobs: [createPersistedJob()] });
      const state = createState(storePath);

      persistFailure.remaining = 1;
      await expect(update(state, "durable-job", { enabled: false })).rejects.toThrow(
        "forced cron persist failure",
      );

      await expect(readJob(state, "durable-job")).resolves.toMatchObject({ enabled: true });
      const retried = await update(state, "durable-job", { enabled: false });
      expect(retried.enabled).toBe(false);
      const persisted = await loadCronStore(storePath);
      expect(persisted.jobs[0]).toMatchObject({ id: "durable-job", enabled: false });
    });
  });

  it("retries removals against the last persisted job after persistence fails", async () => {
    await withOpenClawTestState({ prefix: "cron-remove-rollback-" }, async (stateDir) => {
      const storePath = stateDir.statePath("cron", "jobs.json");
      await saveCronStore(storePath, { version: 1, jobs: [createPersistedJob()] });
      const state = createState(storePath);

      persistFailure.remaining = 1;
      await expect(remove(state, "durable-job")).rejects.toThrow("forced cron persist failure");

      await expect(readJob(state, "durable-job")).resolves.toMatchObject({ id: "durable-job" });
      await expect(remove(state, "durable-job")).resolves.toEqual({ ok: true, removed: true });
      await expect(loadCronStore(storePath)).resolves.toMatchObject({ jobs: [] });
    });
  });
});
