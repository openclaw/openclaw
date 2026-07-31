import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-identity",
});
const NOW = Date.parse("2026-07-30T00:00:00.000Z");

function createJob(): CronJob {
  return {
    id: "reference-stable-job",
    name: "reference stable job",
    enabled: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: { nextRunAtMs: NOW + 60_000 },
  };
}

describe("cron service store identity", () => {
  it("preserves live job identity across state-only saves", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [createJob()] });
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
    if (!state.store) {
      throw new Error("expected loaded cron store");
    }
    const jobs = state.store.jobs;
    const job = findJobOrThrow(state, "reference-stable-job");
    job.state.runningAtMs = NOW + 1;

    await persist(state, { stateOnly: true });

    expect(state.store.jobs).toBe(jobs);
    expect(state.store.jobs[0]).toBe(job);
    job.state.lastRunAtMs = NOW + 2;
    await persist(state, { stateOnly: true });
    expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunAtMs).toBe(NOW + 2);
  });
});
