// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../../../src/cron/normalize.js";
import { applyJobPatch, createJob } from "../../../../src/cron/service/jobs.js";
import { createCronServiceState } from "../../../../src/cron/service/state.js";
import type { CronStoredJob } from "../../../../src/cron/types.js";
import { createTestGatewayScheduler } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { addCronJob, cancelCronEdit, createInitialCronState, startCronEdit } from "./index.ts";
import type { CronState } from "./types.ts";

function createCronJob(overrides: Pick<CronJob, "id" | "name">): CronJob {
  return {
    ...overrides,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
  };
}

function cronJobsListResponse(jobs: CronJob[]) {
  return {
    jobs,
    snapshotRevision: "editor-jobs",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function createStateWithRequest(request: unknown, overrides: Partial<CronState>): CronState {
  return {
    ...createInitialCronState({ connected: true, client: { request } as CronState["client"] }),
    ...overrides,
  };
}

describe("automation save editor ownership", () => {
  it.each(["save", "conflict read", "conflict read failure"] as const)(
    "preserves a reopened editor when an earlier %s settles",
    async (pendingPhase) => {
      const job = createCronJob({ id: "reopened-job", name: "Saved definition" });
      const updated = { ...job, name: "Earlier save", configRevision: "earlier-save-revision" };
      const pending = createDeferred<CronJob>();
      const conflict = Object.assign(new Error("Definition changed"), {
        details: { code: "CRON_JOB_CHANGED" },
      });
      let exactReads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.update") {
          if (pendingPhase === "save") {
            return pending.promise;
          }
          throw conflict;
        }
        if (method === "cron.get") {
          exactReads += 1;
          // Conflict reconciliation first refreshes the selected runtime, then its definition.
          return exactReads === 1 ? job : pending.promise;
        }
        if (method === "cron.list") {
          return cronJobsListResponse([updated]);
        }
        return { enabled: true, jobs: 1 };
      });
      const state = createStateWithRequest(request, { cronJobs: [job] });
      startCronEdit(state, job);
      state.cronForm.name = updated.name;
      const save = addCronJob(state);
      if (pendingPhase !== "save") {
        await vi.waitFor(() => expect(exactReads).toBe(2));
      }
      cancelCronEdit(state, null);
      startCronEdit(state, job);
      state.cronForm.name = "Newer unsaved edit";
      state.cronError = "New editor feedback";
      const reopenedForm = state.cronForm;
      if (pendingPhase === "conflict read failure") {
        pending.reject(new Error("Earlier definition read failed"));
      } else {
        pending.resolve(updated);
      }
      await expect(save).resolves.toEqual(
        pendingPhase === "save" ? { saved: true, jobId: job.id } : { saved: false },
      );
      expect(state.cronEditingJob).toBe(job);
      expect(state.cronForm).toBe(reopenedForm);
      expect(state.cronForm.name).toBe("Newer unsaved edit");
      expect(state.cronEditingJob?.configRevision).toBe(job.configRevision);
      expect(state.cronError).toBe("New editor feedback");
      expect(state.cronBusy).toBe(false);
      expect(state.cronJobs).toEqual([updated]);
    },
  );
});

describe("automation stagger save round trip", () => {
  it.each([
    {
      name: "disabling exact hourly timing",
      expr: "0 * * * *",
      original: 0,
      exact: false,
      amount: "",
      expected: 300_000,
    },
    {
      name: "clearing a custom hourly stagger",
      expr: "0 * * * *",
      original: 120_000,
      exact: false,
      amount: "",
      expected: 300_000,
    },
    {
      name: "clearing a custom daily stagger",
      expr: "0 7 * * *",
      original: 120_000,
      exact: false,
      amount: "",
      expected: 0,
    },
    {
      name: "clearing a custom stagger while changing the daily expression",
      expr: "0 8 * * *",
      originalExpr: "0 7 * * *",
      original: 120_000,
      exact: false,
      amount: "",
      expected: undefined,
    },
    {
      name: "retaining explicit no-stagger when the daily default has no reset value",
      expr: "0 7 * * *",
      original: 0,
      exact: false,
      amount: "",
      expected: 0,
    },
    {
      name: "enabling exact timing",
      expr: "0 * * * *",
      original: 120_000,
      exact: true,
      amount: "",
      expected: 0,
    },
    {
      name: "replacing exact timing with an explicit stagger",
      expr: "0 * * * *",
      original: 0,
      exact: false,
      amount: "45",
      expected: 45_000,
    },
    {
      name: "preserving unchanged exact timing",
      expr: "0 * * * *",
      original: 0,
      exact: true,
      amount: "",
      expected: 0,
      unchanged: true,
    },
  ])(
    "persists $name when the editor reopens",
    async ({ expr, originalExpr, original, exact, amount, expected, unchanged }) => {
      const stored = {
        id: "stagger-round-trip",
        name: "Synthetic stagger task",
        enabled: false,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: originalExpr ?? expr, tz: "UTC", staggerMs: original },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic paused task" },
        state: {},
      } satisfies CronStoredJob;
      const readJob = (): CronJob => ({
        ...structuredClone(stored),
        configRevision: "stagger-revision",
      });
      let submittedSchedule: unknown;
      const request = vi.fn(async (method: string, params?: { patch?: unknown }) => {
        if (method === "cron.update") {
          // Apply the actual Gateway normalization and mutation to the serialized UI patch.
          const serializedPatch = JSON.stringify(params?.patch);
          const wirePatch: unknown = JSON.parse(serializedPatch);
          const patch = normalizeCronJobPatch(wirePatch);
          if (!patch) {
            throw new Error("Expected a valid automation update patch");
          }
          submittedSchedule = patch.schedule;
          applyJobPatch(stored, patch);
          return readJob();
        }
        if (method === "cron.get") {
          return readJob();
        }
        if (method === "cron.list") {
          return cronJobsListResponse([readJob()]);
        }
        return { enabled: true, jobs: 1 };
      });
      const state = createStateWithRequest(request, { cronJobs: [readJob()] });
      startCronEdit(state, readJob());
      state.cronForm = {
        ...state.cronForm,
        description: "Saved from the automation editor",
        cronExpr: expr,
        scheduleExact: exact,
        staggerAmount: amount,
        staggerUnit: "seconds",
      };

      await expect(addCronJob(state)).resolves.toEqual({ saved: true, jobId: stored.id });
      expect(state.cronError).toBeNull();
      cancelCronEdit(state, null);
      startCronEdit(state, readJob());

      expect(stored.schedule).toEqual({ kind: "cron", expr, tz: "UTC", staggerMs: expected });
      expect(state.cronForm.scheduleExact).toBe(expected === 0);
      expect(state.cronForm.staggerAmount).toBe(
        expected === undefined || expected === 0 ? "" : expected === 300_000 ? "5" : "45",
      );
      expect(state.cronForm.staggerUnit).toBe(expected === 300_000 ? "minutes" : "seconds");
      if (unchanged) {
        expect(submittedSchedule).toBeUndefined();
      }
    },
  );
});

describe("automation default timing", () => {
  it.each(["create", "edit"] as const)(
    "preserves an unspecified daily window after %s, reopening, and changing to hourly",
    async (operation) => {
      const service = createCronServiceState({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => 1_800_000_000_000,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storePath: "unused-paused-automation-store",
        cronEnabled: false,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: async () => {
          throw new Error("Paused automation must not execute");
        },
      });
      let stored = createJob(service, {
        id: "default-timing",
        name: "Synthetic default timing",
        enabled: false,
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic paused task" },
      });
      const readJob = (): CronJob => ({
        id: stored.id,
        name: stored.name,
        enabled: stored.enabled,
        createdAtMs: stored.createdAtMs,
        updatedAtMs: stored.updatedAtMs,
        schedule: structuredClone(stored.schedule),
        sessionTarget: stored.sessionTarget,
        wakeMode: stored.wakeMode,
        payload: structuredClone(stored.payload),
        state: structuredClone(stored.state),
        configRevision: "default-timing-revision",
      });
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.add") {
          const serialized = JSON.stringify(params);
          const input = normalizeCronJobCreate(JSON.parse(serialized));
          if (!input) {
            throw new Error("Expected a valid automation create request");
          }
          stored = createJob(service, input);
          return readJob();
        }
        if (method === "cron.update") {
          const serialized = JSON.stringify(params);
          const wire: { patch: unknown } = JSON.parse(serialized);
          const patch = normalizeCronJobPatch(wire.patch);
          if (!patch) {
            throw new Error("Expected a valid automation update patch");
          }
          applyJobPatch(stored, patch);
          return readJob();
        }
        if (method === "cron.list") {
          return cronJobsListResponse([readJob()]);
        }
        return { enabled: false, jobs: 1 };
      });
      const state = createStateWithRequest(request, {});
      if (operation === "create") {
        state.cronForm = {
          ...state.cronForm,
          name: "Synthetic default timing",
          enabled: false,
          scheduleKind: "cron",
          cronExpr: "0 7 * * *",
          cronTz: "UTC",
          sessionTarget: "main",
          payloadKind: "systemEvent",
          payloadText: "Synthetic paused task",
        };
      } else {
        startCronEdit(state, readJob());
        state.cronForm.cronTz = "America/New_York";
      }
      const saved = await addCronJob(state);
      expect(saved).toEqual({ saved: true, jobId: stored.id });
      cancelCronEdit(state, null);
      startCronEdit(state, readJob());
      expect(stored.schedule).toEqual({
        kind: "cron",
        expr: "0 7 * * *",
        tz: operation === "create" ? "UTC" : "America/New_York",
      });
      expect(state.cronForm.scheduleExact).toBe(false);
      expect(state.cronForm.staggerAmount).toBe("");

      state.cronForm.cronExpr = "0 * * * *";
      await expect(addCronJob(state)).resolves.toEqual({ saved: true, jobId: stored.id });
      cancelCronEdit(state, null);
      startCronEdit(state, readJob());
      expect(stored.schedule).toMatchObject({ kind: "cron", staggerMs: 300_000 });
      expect(state.cronForm.scheduleExact).toBe(false);
      expect(state.cronForm.staggerAmount).toBe("5");
      expect(state.cronForm.staggerUnit).toBe("minutes");
    },
  );
});
