import { describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { tryCronRunScheduleIdentity } from "../schedule-identity.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { run, stop, update } from "./ops.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-active-reschedule-" });

describe("cron active reschedule ownership", () => {
  it("does not consume a due one-shot during an ordinary force run", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-force-due-one-shot",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "at", at: new Date(dueAt).toISOString() };
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const storedJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(storedJob).toMatchObject({
      enabled: true,
      schedule: job.schedule,
      state: { lastStatus: "ok", nextRunAtMs: dueAt },
    });
    stop(state);
  });

  it("keeps a one-shot that is rescheduled while its manual due run is active", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const futureAt = dueAt + 3_600_000;
    const job = createDueIsolatedJob({
      id: "manual-active-reschedule",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "at", at: new Date(dueAt).toISOString() };
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finish = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await finish.promise;
      }),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
      activeRunScheduleMode: "advance",
      activeRunInstanceIdentity: expect.stringMatching(/^sha256:/),
      activeRunScheduleIdentity: expect.stringMatching(/^sha256:/),
      activeRunStateIdentity: expect.stringMatching(/^sha256:/),
    });
    await update(state, job.id, {
      schedule: { kind: "at", at: new Date(futureAt).toISOString() },
    });
    finish.resolve({ status: "ok", summary: "old slot complete" });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    for (const storedJob of [
      state.store?.jobs.find((entry) => entry.id === job.id),
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id),
    ]) {
      expect(storedJob).toMatchObject({
        enabled: true,
        schedule: { kind: "at", at: new Date(futureAt).toISOString() },
        state: { lastStatus: "ok", nextRunAtMs: futureAt },
      });
    }
    stop(state);
  });

  it("keeps a one-shot re-armed through an ABA edit while its old run is active", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({ id: "manual-active-aba", nowMs: dueAt, nextRunAtMs: dueAt });
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finish = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await finish.promise;
      }),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    await update(state, job.id, { enabled: false });
    await update(state, job.id, { enabled: true });
    finish.resolve({ status: "ok", summary: "old slot complete" });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    const storedJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(storedJob).toMatchObject({
      enabled: true,
      schedule: job.schedule,
      state: { lastStatus: "ok", nextRunAtMs: dueAt, scheduleRevision: 2 },
    });
    stop(state);
  });

  it("keeps an explicitly selected next run while the old one-shot is active", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const futureAt = dueAt + 3_600_000;
    const job = createDueIsolatedJob({
      id: "manual-active-state-reschedule",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finish = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await finish.promise;
      }),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    await update(state, job.id, { state: { nextRunAtMs: futureAt } });
    finish.resolve({ status: "ok", summary: "old slot complete" });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    const storedJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(storedJob).toMatchObject({
      enabled: true,
      state: { lastStatus: "ok", nextRunAtMs: futureAt, scheduleRevision: 1 },
    });
    stop(state);
  });

  it("keeps explicitly patched trigger state when an old evaluation completes", async () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-trigger-state-patch",
      nowMs: now,
      nextRunAtMs: now,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 };
    job.trigger = { script: "return { fire: true }", once: true };
    job.state.triggerState = { owner: "old" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finishEvaluation = createDeferred<{
      kind: "evaluated";
      fire: true;
      state: { owner: string };
    }>();
    const state = createCronServiceState({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn(async () => {
        started.resolve();
        return await finishEvaluation.promise;
      }),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    await update(state, job.id, { state: { triggerState: { owner: "operator" } } });
    finishEvaluation.resolve({ kind: "evaluated", fire: true, state: { owner: "old-run" } });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    const storedJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(storedJob?.state.triggerState).toEqual({ owner: "operator" });
    expect(storedJob?.state.stateRevision).toBe(1);
    expect(storedJob?.enabled).toBe(false);
    expect(storedJob?.state.nextRunAtMs).toBeUndefined();
    stop(state);
  });

  it("keeps a recreated job with the same id and definition after the old run completes", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-active-recreated",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.deleteAfterRun = true;
    job.state.instanceId = "old-instance";
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finish = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await finish.promise;
      }),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    const replacement = structuredClone(job);
    replacement.state.instanceId = "replacement-instance";
    replacement.state.lastRunStatus = "error";
    replacement.state.lastStatus = "error";
    await saveCronStore(store.storePath, { version: 1, jobs: [replacement] });
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    finish.resolve({ status: "ok", summary: "old instance complete" });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    for (const storedJob of [
      state.store?.jobs.find((entry) => entry.id === job.id),
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id),
    ]) {
      expect(storedJob?.state.instanceId).toBe("replacement-instance");
      expect(storedJob?.state.lastRunStatus).toBe("error");
      expect(storedJob?.state.lastStatus).toBe("error");
    }
    stop(state);
  });

  it("keeps an on-exit replacement installed while a manual due run is active", async () => {
    const store = fixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-active-on-exit-replacement",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "at", at: new Date(dueAt).toISOString() };
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finish = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        started.resolve();
        return await finish.promise;
      }),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    await update(state, job.id, {
      schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
    });
    finish.resolve({ status: "ok", summary: "old slot complete" });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    for (const storedJob of [
      state.store?.jobs.find((entry) => entry.id === job.id),
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id),
    ]) {
      expect(storedJob).toMatchObject({
        enabled: true,
        schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
        state: { lastStatus: "ok" },
      });
    }
    stop(state);
  });

  it("keeps an unchanged on-exit schedule after an operator force run", async () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-on-exit-force",
      nowMs: now,
      nextRunAtMs: now,
    });
    job.schedule = { kind: "on-exit", command: 'sh -c "exit 0"' };
    job.deleteAfterRun = true;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "manual complete",
      })),
    });

    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    for (const storedJob of [
      state.store?.jobs.find((entry) => entry.id === job.id),
      (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id),
    ]) {
      expect(storedJob).toMatchObject({
        enabled: true,
        schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
        state: { lastStatus: "ok" },
      });
    }
    stop(state);
  });

  it("rejects a stale watcher exit after its on-exit schedule is replaced", async () => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({ id: "stale-on-exit", nowMs: now, nextRunAtMs: now });
    job.schedule = { kind: "on-exit", command: "old-command" };
    job.enabled = false;
    const expectedScheduleIdentity = tryCronRunScheduleIdentity(job);
    if (!expectedScheduleIdentity) {
      throw new Error("expected watcher schedule identity");
    }
    job.schedule = { kind: "on-exit", command: "replacement-command" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await expect(
      run(state, job.id, "force", { consumeSchedule: true, expectedScheduleIdentity }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect((await loadCronStore(store.storePath)).jobs[0]?.schedule).toEqual({
      kind: "on-exit",
      command: "replacement-command",
    });
    stop(state);
  });

  it.each([
    { label: "fired replacement", fired: true, aba: false },
    { label: "quiet replacement", fired: false, aba: false },
    { label: "ABA replacement", fired: true, aba: true },
  ])("does not apply an old trigger result after a $label", async ({ fired, aba }) => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:04:00.000Z");
    const job = createDueIsolatedJob({
      id: `manual-trigger-replacement-${fired}`,
      nowMs: now,
      nextRunAtMs: now,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 };
    job.trigger = { script: "return { fire: true }", once: true };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<void>();
    const finishEvaluation = createDeferred<{
      kind: "evaluated";
      fire: boolean;
      state: { owner: string };
    }>();
    const state = createCronServiceState({
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn(async () => {
        started.resolve();
        return await finishEvaluation.promise;
      }),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const manualRun = run(state, job.id, "due");
    await started.promise;
    await update(state, job.id, {
      trigger: { script: "return { fire: false }", once: true },
    });
    if (aba) {
      await update(state, job.id, {
        trigger: { script: "return { fire: true }", once: true },
      });
    }
    finishEvaluation.resolve({
      kind: "evaluated",
      fire: fired,
      state: { owner: "old-trigger" },
    });
    await expect(manualRun).resolves.toEqual({ ok: true, ran: true });

    const storedJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(storedJob).toMatchObject({
      enabled: true,
      trigger: { script: aba ? "return { fire: true }" : "return { fire: false }", once: true },
    });
    expect(storedJob?.state.scheduleRevision).toBe(aba ? 2 : 1);
    expect(storedJob?.state.stateRevision).toBe(aba ? 2 : 1);
    expect(storedJob?.state.triggerState).not.toEqual({ owner: "old-trigger" });
    stop(state);
  });
});
