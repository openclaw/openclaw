// @vitest-environment node
import { expect, it, vi } from "vitest";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../../../src/cron/normalize.js";
import { applyJobPatch, createJob } from "../../../../src/cron/service/jobs.js";
import { createCronServiceState } from "../../../../src/cron/service/state.js";
import type { CronStoredJob } from "../../../../src/cron/types.js";
import { createTestGatewayScheduler } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import {
  createStateWithRequest,
  createCronJob,
  cronJobsListResponse,
} from "./cron.test-support.ts";
import { addCronJob, cancelCronEdit, startCronEdit } from "./index.ts";

function applyWirePatch(stored: CronStoredJob, params: unknown) {
  // Exercise the Gateway's normalization against the serialized UI request.
  const serialized = JSON.stringify(params);
  const wire: { patch: unknown } = JSON.parse(serialized);
  const patch = normalizeCronJobPatch(wire.patch);
  if (!patch) {
    throw new Error("Expected a valid automation update patch");
  }
  applyJobPatch(stored, patch);
  return patch.schedule;
}

function wireEditor(initial: CronStoredJob, create?: (input: unknown) => CronStoredJob) {
  let stored = initial;
  let submittedSchedule: unknown;
  const readJob = (): CronJob => ({ ...structuredClone(stored), configRevision: "revision" });
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "cron.add" && create) {
      stored = create(params);
    } else if (method === "cron.update") {
      submittedSchedule = applyWirePatch(stored, params);
    } else if (method === "cron.list") {
      return cronJobsListResponse([readJob()]);
    } else if (method !== "cron.get" || create) {
      return { enabled: !create, jobs: 1 };
    }
    return readJob();
  });
  const state = createStateWithRequest(request, { cronJobs: create ? [] : [readJob()] });
  return {
    state,
    readJob,
    get stored() {
      return stored;
    },
    get submittedSchedule() {
      return submittedSchedule;
    },
    reopen() {
      cancelCronEdit(state, null);
      startCronEdit(state, readJob());
    },
  };
}

it.each(["save", "conflict read", "conflict read failure"] as const)(
  "preserves a reopened editor when an earlier %s settles",
  async (pendingPhase) => {
    const job = createCronJob("reopened-job", "Saved definition");
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
    expect(state.cronError).toBe("New editor feedback");
    expect(state.cronBusy).toBe(false);
    expect(state.cronJobs).toEqual([updated]);
  },
);

it.each([
  // expression, saved window, exact, entered seconds, persisted window, old expression, unchanged
  ["0 * * * *", 0, false, "", 300_000, undefined, false],
  ["0 7 * * *", 120_000, false, "", 0, undefined, false],
  ["0 8 * * *", 120_000, false, "", undefined, "0 7 * * *", false],
  ["0 * * * *", 120_000, true, "", 0, undefined, false],
  ["0 * * * *", 0, false, "45", 45_000, undefined, false],
  ["0 * * * *", 0, true, "", 0, undefined, true],
] as const)(
  "round-trips expression=%s, saved=%s, exact=%s, amount=%s to %s",
  async (expr, original, exact, amount, expected, originalExpr, unchanged) => {
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
    const editor = wireEditor(stored);
    const { state } = editor;
    startCronEdit(state, editor.readJob());
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
    editor.reopen();

    expect(stored.schedule).toEqual({ kind: "cron", expr, tz: "UTC", staggerMs: expected });
    expect(state.cronForm).toMatchObject({
      scheduleExact: expected === 0,
      staggerAmount:
        expected === undefined || expected === 0 ? "" : expected === 300_000 ? "5" : "45",
      staggerUnit: expected === 300_000 ? "minutes" : "seconds",
    });
    if (unchanged) {
      expect(editor.submittedSchedule).toBeUndefined();
    }
  },
);

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
    const initial = createJob(service, {
      id: "default-timing",
      name: "Synthetic default timing",
      enabled: false,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic paused task" },
    });
    const editor = wireEditor(initial, (params) => {
      const serialized = JSON.stringify(params);
      const input = normalizeCronJobCreate(JSON.parse(serialized));
      if (!input) {
        throw new Error("Expected a valid automation create request");
      }
      return createJob(service, input);
    });
    const { state } = editor;
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
      startCronEdit(state, editor.readJob());
      state.cronForm.cronTz = "America/New_York";
    }
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: editor.stored.id });
    editor.reopen();
    expect(editor.stored.schedule).toEqual({
      kind: "cron",
      expr: "0 7 * * *",
      tz: operation === "create" ? "UTC" : "America/New_York",
    });
    expect(state.cronForm).toMatchObject({ scheduleExact: false, staggerAmount: "" });

    state.cronForm.cronExpr = "0 * * * *";
    await expect(addCronJob(state)).resolves.toEqual({ saved: true, jobId: editor.stored.id });
    editor.reopen();
    expect(editor.stored.schedule).toMatchObject({ kind: "cron", staggerMs: 300_000 });
    expect(state.cronForm).toMatchObject({
      scheduleExact: false,
      staggerAmount: "5",
      staggerUnit: "minutes",
    });
  },
);
