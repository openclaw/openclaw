import { describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { CronStoreEpochMismatchError, loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { getCronStoreKysely } from "../store/schema.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-runtime-revision",
});
const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

describe("cron service runtime revisions", () => {
  it("publishes a revision-quiet preserved value before the next persist", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("revision-quiet")] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await ensureLoaded(state, { skipRecompute: true });

    const external = await loadCronStore(storePath);
    external.jobs[0]!.name = "external topology";
    await saveCronStore(storePath, external);

    const realSave = cronStoreModule.saveCronJobsStore;
    let saveCall = 0;
    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockImplementation(async (...args) => {
      saveCall += 1;
      if (saveCall === 2) {
        runOpenClawStateWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .updateTable("cron_jobs")
              .set({
                running_at_ms: NOW + 1,
                runtime_updated_at_ms: NOW + 1,
                state_json: JSON.stringify({ runningAtMs: NOW + 1 }),
              })
              .where("store_key", "=", cronStoreKey(storePath))
              .where("job_id", "=", "revision-quiet"),
          );
        });
      }
      return await realSave(...args);
    });

    await expect(persist(state)).rejects.toBeInstanceOf(CronStoreEpochMismatchError);
    expect(state.store?.jobs[0]?.state.runningAtMs).toBe(NOW + 1);

    await persist(state, { stateOnly: true });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(NOW + 1);
  });

  it("publishes merged sibling runtime state after a stale full save", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("edited"), job("sibling")] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await ensureLoaded(state, { skipRecompute: true });

    const concurrent = await loadCronStore(storePath);
    const sibling = concurrent.jobs.find((entry) => entry.id === "sibling")!;
    sibling.state = { nextRunAtMs: NOW + 120_000, lastStatus: "ok" };
    await saveCronStore(storePath, concurrent, {
      stateOnly: true,
      expectedStoreEpoch: state.storeEpoch,
      expectedRuntimeRevision: state.runtimeRevision,
    });

    const edited = state.store?.jobs.find((entry) => entry.id === "edited");
    const originalStore = state.store;
    const originalJobs = state.store?.jobs;
    const originalSibling = state.store?.jobs.find((entry) => entry.id === "sibling");
    if (!edited) {
      throw new Error("missing edited cron fixture");
    }
    edited.name = "renamed";
    edited.updatedAtMs = NOW;
    await persist(state);

    const inMemorySibling = state.store?.jobs.find((entry) => entry.id === "sibling");
    expect(state.store).toBe(originalStore);
    expect(state.store?.jobs).toBe(originalJobs);
    expect(state.store?.jobs.find((entry) => entry.id === "edited")).toBe(edited);
    expect(inMemorySibling).toBe(originalSibling);
    expect(state.store?.jobs.find((entry) => entry.id === "edited")?.updatedAtMs).toBe(NOW);
    expect(inMemorySibling?.state).toMatchObject({
      nextRunAtMs: NOW + 120_000,
      lastStatus: "ok",
    });
    const durable = await loadCronStore(storePath);
    expect(durable.jobs.find((entry) => entry.id === "edited")?.updatedAtMs).toBe(NOW);
    expect(durable.jobs.find((entry) => entry.id === "sibling")?.state).toEqual(
      inMemorySibling?.state,
    );
  });

  it("keeps the canonical overdue wake after rejecting a stale schedule edit", async () => {
    const { storePath } = await makeStorePath();
    const canonical = {
      ...job("stale-schedule"),
      state: { nextRunAtMs: NOW - 1_000 },
    };
    await saveCronStore(storePath, { version: 1, jobs: [canonical] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await ensureLoaded(state, { skipRecompute: true });
    state.store!.jobs[0]!.schedule = { kind: "every", everyMs: 120_000 };

    const concurrent = await loadCronStore(storePath);
    concurrent.jobs[0]!.name = "durable rename";
    await saveCronStore(storePath, concurrent);

    await expect(persist(state)).rejects.toBeInstanceOf(CronStoreEpochMismatchError);

    expect(state.store?.jobs[0]?.schedule).toEqual(canonical.schedule);
    expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(NOW - 1_000);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(NOW - 1_000);
  });

  it("invalidates a wake when the concurrent durable schedule changed", async () => {
    const { storePath } = await makeStorePath();
    const staleWake = NOW + 10_000;
    await saveCronStore(storePath, {
      version: 1,
      jobs: [{ ...job("durable-schedule"), state: { nextRunAtMs: staleWake } }],
    });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await ensureLoaded(state, { skipRecompute: true });
    state.store!.jobs[0]!.name = "local rename";

    const concurrent = await loadCronStore(storePath);
    concurrent.jobs[0]!.schedule = { kind: "every", everyMs: 300_000 };
    await saveCronStore(storePath, concurrent);

    await expect(persist(state)).rejects.toBeInstanceOf(CronStoreEpochMismatchError);

    expect(state.store?.jobs[0]?.schedule).toEqual({ kind: "every", everyMs: 300_000 });
    expect(state.store?.jobs[0]?.state.nextRunAtMs).not.toBe(staleWake);
  });
});
