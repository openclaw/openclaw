// @vitest-environment node
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { CronJobSchema } from "../../../../packages/gateway-protocol/src/schema/cron.js";
import { cronJobReadView } from "../../../../src/cron/job-read-view.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../../../src/cron/normalize.js";
import { applyJobPatch, createJob } from "../../../../src/cron/service/jobs.js";
import { createCronServiceState } from "../../../../src/cron/service/state.js";
import type { CronStoredJob } from "../../../../src/cron/types.js";
import { createTestGatewayScheduler } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { invalidateStaleDeliveryRoute } from "../../pages/cron/delivery-conversations.ts";
import { createCronJob, cronJobsListResponse } from "../../test-helpers/cron.ts";
import { createMethodRequest, createStateWithRequest } from "./cron.test-support.ts";
import { addCronJob, cancelCronEdit, startCronEdit } from "./index.ts";
import type { CronFormState, CronState } from "./types.ts";

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

function readPublicJob(stored: CronStoredJob): CronJob {
  const response = JSON.stringify(cronJobReadView(stored));
  const job: unknown = JSON.parse(response);
  if (!Value.Check(CronJobSchema, job)) {
    throw new Error("Expected a public automation job from the Gateway read projection");
  }
  return job;
}

function storedJob(overrides: Partial<CronStoredJob>): CronStoredJob {
  return {
    id: "saved-job",
    name: "Synthetic task",
    enabled: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

function createSaveState(
  stored: CronStoredJob,
  readJob = () => readPublicJob(stored),
  { enabled = false, onPatch = (_schedule: unknown) => {} } = {},
) {
  return createStateWithRequest(
    createMethodRequest(
      { "cron.status": { enabled, jobs: 1 } },
      {
        "cron.update": (params) => {
          onPatch(applyWirePatch(stored, params));
          return readJob();
        },
        "cron.get": readJob,
        "cron.list": () => cronJobsListResponse([readJob()]),
      },
    ),
  );
}

async function saveAndReopen(state: CronState, readJob: () => CronJob) {
  await expect(addCronJob(state)).resolves.toEqual({ saved: true, jobId: readJob().id });
  expect(state.cronError).toBeNull();
  cancelCronEdit(state, null);
  startCronEdit(state, readJob());
}

describe("automation save editor ownership", () => {
  it.each([true, false])("saves ordinary job policies enabled=%s", async (enabled) => {
    const stored = storedJob({
      sessionTarget: enabled ? "main" : "session:agent:main:main",
      activeHours: { start: "22:00", end: "06:00", timezone: "UTC" },
      idleOnly: true,
      payload: {
        kind: "agentTurn",
        message: "Check notes",
        skipIfScratchEmpty: true,
        includeReasoning: true,
      },
      delivery: enabled
        ? { mode: "none" }
        : {
            mode: "announce",
            channel: "telegram",
            accountId: "operator",
            to: "old-group",
            threadId: 5,
            directPolicy: "block",
          },
    });
    const readJob = () => readPublicJob(stored);
    const state = createSaveState(stored);
    startCronEdit(state, readJob());
    expect(state.cronForm.payloadLocked).toBe(false);
    if (!enabled) {
      Object.assign(state.cronForm, {
        activeHoursEnabled: false,
        idleOnly: false,
        payloadSkipIfScratchEmpty: false,
        payloadIncludeReasoning: false,
        deliveryTarget: "owner",
        deliveryDirectPolicy: "allow",
      });
    }
    await saveAndReopen(state, readJob);
    expect(stored).toMatchObject({
      sessionTarget: enabled ? "main" : "session:agent:main:main",
      idleOnly: enabled,
      payload: {
        kind: "agentTurn",
        message: "Check notes",
        skipIfScratchEmpty: enabled,
        includeReasoning: enabled,
      },
    });
    expect(stored.activeHours).toEqual(
      enabled ? { start: "22:00", end: "06:00", timezone: "UTC" } : undefined,
    );
    if (!enabled) {
      expect(stored.delivery).toMatchObject({
        mode: "announce",
        target: "owner",
        channel: "telegram",
        accountId: "operator",
        directPolicy: "allow",
      });
      expect(stored.delivery?.to).toBeUndefined();
      expect(stored.delivery?.threadId).toBeUndefined();
    }
  });

  it.each([true, false])("re-enables disabled delivery for owner=%s", async (owner) => {
    const stored = storedJob({
      delivery: {
        mode: "none",
        target: "owner",
        directPolicy: "block",
        channel: "telegram",
        accountId: "operator",
      },
    });
    const readJob = () => readPublicJob(stored);
    const state = createSaveState(stored);
    startCronEdit(state, readJob());
    expect(state.cronForm.deliveryMode).toBe("none");
    Object.assign(state.cronForm, {
      deliveryMode: "announce",
      ...(!owner ? { deliveryTarget: "", deliveryTo: "team-room", deliveryDirectPolicy: "" } : {}),
    });
    await saveAndReopen(state, readJob);
    expect(stored.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      accountId: "operator",
    });
    expect(stored.delivery?.target).toBe(owner ? "owner" : undefined);
    expect(stored.delivery?.directPolicy).toBe(owner ? "block" : undefined);
    expect(stored.delivery?.to).toBe(owner ? undefined : "team-room");
    expect(stored.delivery?.threadId).toBeUndefined();
    expect(state.cronForm).toMatchObject({
      deliveryMode: "announce",
      deliveryTarget: owner ? "owner" : "",
      deliveryTo: owner ? "" : "team-room",
      deliveryDirectPolicy: owner ? "block" : "",
    });
  });

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
});

it.each<
  [
    name: string,
    patch: Partial<CronFormState>,
    threadId: string | number,
    expected: string | number | undefined,
  ]
>([
  ["recipient change", { deliveryTo: "-100new" }, 42, undefined],
  ["account change", { deliveryAccountId: "new" }, 42, undefined],
  ["channel change", { deliveryChannel: "last" }, 42, undefined],
  ["agent change", { agentId: "other" }, 42, undefined],
  ["cleared agent override", { clearAgent: true }, 42, undefined],
  ["delivery disabled", { deliveryMode: "none" }, 42, undefined],
  ["unchanged topic", { description: "Edited" }, 42, 42],
  ["zero topic", { description: "Edited" }, 0, 0],
  ["recipient whitespace", { deliveryTo: " -100old " }, 42, 42],
  ["account whitespace", { deliveryAccountId: " old " }, 42, 42],
  ["agent whitespace", { agentId: " writer " }, 42, 42],
  ["replacement topic", { deliveryTo: "-100new", deliveryThreadId: "topic-new" }, 42, "topic-new"],
])("persists %s after saving and reopening", async (_name, patch, threadId, expected) => {
  const stored = storedJob({
    agentId: "writer",
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "-100old",
      accountId: "old",
      threadId,
    },
  });
  const readJob = () => readPublicJob(stored);
  const state = createSaveState(stored, readJob);
  startCronEdit(state, readJob());
  state.cronForm = { ...state.cronForm, ...invalidateStaleDeliveryRoute(state.cronForm, patch) };

  await saveAndReopen(state, readJob);
  expect(stored.delivery?.threadId).toBe(expected);
  expect(state.cronForm.deliveryThreadId).toBe(expected);
});

it.each<
  [
    name: string,
    expr: string,
    original: number,
    exact: boolean,
    amount: string,
    expected: number | undefined,
    originalExpr?: string,
    unchanged?: boolean,
  ]
>([
  ["disabling exact hourly timing", "0 * * * *", 0, false, "", 300_000],
  ["clearing a custom daily stagger", "0 7 * * *", 120_000, false, "", 0],
  ["changing the daily expression", "0 8 * * *", 120_000, false, "", undefined, "0 7 * * *"],
  ["enabling exact timing", "0 * * * *", 120_000, true, "", 0],
  ["replacing exact timing with a stagger", "0 * * * *", 0, false, "45", 45_000],
  ["preserving unchanged exact timing", "0 * * * *", 0, true, "", 0, undefined, true],
])(
  "persists %s when the editor reopens",
  async (_name, expr, original, exact, amount, expected, originalExpr, unchanged) => {
    const stored = storedJob({
      schedule: { kind: "cron", expr: originalExpr ?? expr, tz: "UTC", staggerMs: original },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Synthetic paused task" },
    });
    const readJob = () => readPublicJob(stored);
    let submittedSchedule: unknown;
    const state = createSaveState(stored, readJob, {
      enabled: true,
      onPatch: (schedule) => {
        submittedSchedule = schedule;
      },
    });
    state.cronJobs = [readJob()];
    startCronEdit(state, readJob());
    state.cronForm = {
      ...state.cronForm,
      description: "Saved from the automation editor",
      cronExpr: expr,
      scheduleExact: exact,
      staggerAmount: amount,
      staggerUnit: "seconds",
    };

    await saveAndReopen(state, readJob);

    expect(stored.schedule).toEqual({ kind: "cron", expr, tz: "UTC", staggerMs: expected });
    expect(state.cronForm).toMatchObject({
      scheduleExact: expected === 0,
      staggerAmount:
        expected === undefined || expected === 0 ? "" : expected === 300_000 ? "5" : "45",
      staggerUnit: expected === 300_000 ? "minutes" : "seconds",
    });
    if (unchanged) {
      expect(submittedSchedule).toBeUndefined();
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
      enqueueSessionEvent: vi.fn(),
      runIsolatedAgentJob: async () => {
        throw new Error("Paused automation must not execute");
      },
    });
    let stored = createJob(
      service,
      storedJob({
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic paused task" },
      }),
    );
    const readJob = () => readPublicJob(stored);
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
        applyWirePatch(stored, params);
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
    await saveAndReopen(state, readJob);
    expect(stored.schedule).toEqual({
      kind: "cron",
      expr: "0 7 * * *",
      tz: operation === "create" ? "UTC" : "America/New_York",
    });
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("");

    state.cronForm.cronExpr = "0 * * * *";
    await saveAndReopen(state, readJob);
    expect(stored.schedule).toMatchObject({ kind: "cron", staggerMs: 300_000 });
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("5");
    expect(state.cronForm.staggerUnit).toBe("minutes");
  },
);
