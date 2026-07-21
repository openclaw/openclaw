import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  tryCronRunInstanceIdentity,
  tryCronRunScheduleIdentity,
  tryCronRunStateIdentity,
  tryCronRunTriggerIdentity,
} from "../schedule-identity.js";
import { markInterruptedStartupRun, restoreFinalizedStartupRun } from "./startup-run-repair.js";
import { createCronServiceState } from "./state.js";

describe("cron startup run schedule ownership", () => {
  it("preserves a legacy future reschedule when interrupted ownership is absent", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const now = startedAt + 1_000;
    const futureAt = startedAt + 3_600_000;
    const job = createDueIsolatedJob({
      id: "startup-legacy-interrupted-reschedule",
      nowMs: startedAt,
      nextRunAtMs: futureAt,
    });
    job.schedule = { kind: "at", at: new Date(futureAt).toISOString() };
    job.deleteAfterRun = true;
    job.state.runningAtMs = startedAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-legacy-interrupted-reschedule/jobs.json",
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    markInterruptedStartupRun({ state, job, runningAtMs: startedAt, nowMs: now });

    expect(job).toMatchObject({
      enabled: true,
      schedule: { kind: "at", at: new Date(futureAt).toISOString() },
      state: { lastStatus: "error", nextRunAtMs: futureAt },
    });
  });

  it("consumes an unchanged legacy due one-shot when interrupted ownership is absent", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const now = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "startup-legacy-interrupted-due",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
    job.state.runningAtMs = startedAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-legacy-interrupted-due/jobs.json",
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    markInterruptedStartupRun({ state, job, runningAtMs: startedAt, nowMs: now });

    expect(job).toMatchObject({
      enabled: false,
      state: { lastStatus: "error", nextRunAtMs: undefined },
    });
  });

  it("preserves a future reschedule when the admitted run is interrupted", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const now = startedAt + 1_000;
    const futureAt = startedAt + 3_600_000;
    const job = createDueIsolatedJob({
      id: "startup-interrupted-reschedule",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.state.instanceId = "same-instance";
    const runInstanceIdentity = tryCronRunInstanceIdentity(job);
    const runScheduleIdentity = tryCronRunScheduleIdentity(job);
    if (!runInstanceIdentity || !runScheduleIdentity) {
      throw new Error("expected admitted ownership identity");
    }
    job.schedule = { kind: "at", at: new Date(futureAt).toISOString() };
    job.state.nextRunAtMs = futureAt;
    job.state.runningAtMs = startedAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-interrupted-reschedule/jobs.json",
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      markInterruptedStartupRun({
        state,
        job,
        runningAtMs: startedAt,
        nowMs: now,
        runInstanceIdentity,
        runScheduleIdentity,
        runScheduleMode: "advance",
      }).ownsJobInstance,
    ).toBe(true);
    expect(job).toMatchObject({
      enabled: true,
      schedule: { kind: "at", at: new Date(futureAt).toISOString() },
      state: { lastStatus: "error", nextRunAtMs: futureAt },
    });
  });

  it("preserves an unchanged future one-shot when a force run is interrupted", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const now = startedAt + 1_000;
    const futureAt = startedAt + 3_600_000;
    const job = createDueIsolatedJob({
      id: "startup-interrupted-force",
      nowMs: startedAt,
      nextRunAtMs: futureAt,
    });
    job.state.instanceId = "force-instance";
    job.state.runningAtMs = startedAt;
    const runInstanceIdentity = tryCronRunInstanceIdentity(job);
    const runScheduleIdentity = tryCronRunScheduleIdentity(job);
    if (!runInstanceIdentity || !runScheduleIdentity) {
      throw new Error("expected admitted force ownership identity");
    }
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-interrupted-force/jobs.json",
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    markInterruptedStartupRun({
      state,
      job,
      runningAtMs: startedAt,
      nowMs: now,
      runInstanceIdentity,
      runScheduleIdentity,
      runScheduleMode: "preserve",
    });
    expect(job).toMatchObject({
      enabled: true,
      state: { lastStatus: "error", nextRunAtMs: futureAt },
    });
  });

  it("does not mutate a recreated job when the old instance is interrupted", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const now = startedAt + 1_000;
    const oldJob = createDueIsolatedJob({
      id: "startup-recreated",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    oldJob.state.instanceId = "old-instance";
    const runInstanceIdentity = tryCronRunInstanceIdentity(oldJob);
    if (!runInstanceIdentity) {
      throw new Error("expected old instance identity");
    }
    const replacement = structuredClone(oldJob);
    replacement.state.instanceId = "replacement-instance";
    replacement.state.runningAtMs = startedAt;
    replacement.state.lastStatus = "ok";
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-interrupted-recreated/jobs.json",
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      markInterruptedStartupRun({
        state,
        job: replacement,
        runningAtMs: startedAt,
        nowMs: now,
        runInstanceIdentity,
      }).ownsJobInstance,
    ).toBe(false);
    expect(replacement.state).toMatchObject({
      instanceId: "replacement-instance",
      runningAtMs: startedAt,
      lastStatus: "ok",
    });
  });

  it("replays an operator force run without consuming its unchanged one-shot schedule", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const endedAt = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "startup-force-preserve",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.schedule = { kind: "at", at: new Date(startedAt).toISOString() };
    job.deleteAfterRun = true;
    job.state.runningAtMs = startedAt;
    const runScheduleIdentity = tryCronRunScheduleIdentity(job);
    if (!runScheduleIdentity) {
      throw new Error("expected run schedule identity");
    }
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-force-preserve/jobs.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: startedAt,
        runScheduleIdentity,
        runScheduleMode: "preserve",
        entry: {
          ts: endedAt,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: startedAt,
          nextRunAtMs: undefined,
        },
      }),
    ).toBe(false);
    expect(job).toMatchObject({
      enabled: true,
      state: { lastStatus: "ok", nextRunAtMs: startedAt },
    });
  });

  it("disarms a recovered once trigger without overwriting newer shared state", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const endedAt = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "startup-trigger-state-owner",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt - 60_000 };
    job.trigger = { script: "return { fire: true }", once: true };
    job.state.instanceId = "startup-trigger-state-instance";
    job.state.triggerState = { owner: "admitted" };
    const runTriggerIdentity = tryCronRunTriggerIdentity(job);
    const runStateIdentity = tryCronRunStateIdentity(job);
    if (!runTriggerIdentity || !runStateIdentity) {
      throw new Error("expected trigger ownership identities");
    }
    job.state.stateRevision = 1;
    job.state.triggerState = { owner: "operator" };
    job.updatedAtMs = endedAt;
    job.state.runningAtMs = startedAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-trigger-state-owner/jobs.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs: startedAt,
      runTriggerIdentity,
      runStateIdentity,
      triggerEval: { fired: true, stateChanged: true, state: { owner: "old-run" } },
      entry: {
        ts: endedAt,
        jobId: job.id,
        action: "finished",
        status: "ok",
        runAtMs: startedAt,
        nextRunAtMs: startedAt + 60_000,
      },
    });

    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.triggerState).toEqual({ owner: "operator" });
  });

  it("preserves a legacy disabled on-exit replacement edited after admission", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const endedAt = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "legacy-disabled-on-exit-replacement",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.schedule = { kind: "on-exit", command: "replacement-command" };
    job.enabled = false;
    job.deleteAfterRun = true;
    job.updatedAtMs = endedAt;
    job.state = { runningAtMs: startedAt };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-legacy-on-exit/jobs.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: startedAt,
        entry: {
          ts: endedAt,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: startedAt,
        },
      }),
    ).toBe(false);
    expect(job).toMatchObject({
      enabled: false,
      schedule: { kind: "on-exit", command: "replacement-command" },
    });
  });

  it("preserves a legacy disabled at replacement edited after admission", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const endedAt = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "legacy-disabled-at-replacement",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.schedule = { kind: "at", at: new Date(startedAt + 3_600_000).toISOString() };
    job.enabled = false;
    job.deleteAfterRun = true;
    job.updatedAtMs = endedAt;
    job.state = { runningAtMs: startedAt };
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-legacy-disabled-at/jobs.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: startedAt,
        entry: {
          ts: endedAt,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: startedAt,
        },
      }),
    ).toBe(false);
    expect(job).toMatchObject({
      enabled: false,
      schedule: { kind: "at", at: new Date(startedAt + 3_600_000).toISOString() },
    });
  });

  it("consumes a legacy at schedule after an unrelated edit", () => {
    const startedAt = Date.parse("2026-02-06T10:04:00.000Z");
    const endedAt = startedAt + 1_000;
    const job = createDueIsolatedJob({
      id: "legacy-at-unrelated-edit",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.deleteAfterRun = true;
    job.updatedAtMs = endedAt;
    job.state.runningAtMs = startedAt;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-startup-legacy-at/jobs.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    expect(
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: startedAt,
        entry: {
          ts: endedAt,
          jobId: job.id,
          action: "finished",
          status: "ok",
          runAtMs: startedAt,
        },
      }),
    ).toBe(true);
  });
});
