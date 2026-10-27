// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import {
  addCronJob,
  toggleCronJob,
  loadCronJobsPage,
  removeCronJob,
  startCronEdit,
  startCronClone,
} from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import {
  DEFAULT_CRON_FORM,
  createCronJob,
  cronJobsListResponse as jobsPage,
} from "../../test-helpers/cron.ts";
import { createMethodRequest, createStateWithRequest as createState } from "./cron.test-support.ts";

function requestFor(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob(jobId, "Existing job");
  const jobs = options.existing ? [existingJob] : [];
  return createMethodRequest({
    "cron.add": { job: { id: jobId } },
    "cron.update": existingJob,
    "cron.list": jobsPage(jobs),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  });
}

function newJob(jobId: string, form: Partial<CronState["cronForm"]> = {}) {
  const request = requestFor(jobId);
  const state = createState(request);
  state.cronForm = { ...DEFAULT_CRON_FORM, name: jobId, payloadText: "run", ...form };
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: sent(request), result };
  };
  return { request, state, submit };
}

type Rejection = { form: Partial<CronState["cronForm"]>; field: string; error: string };

function editJob(
  job: CronJob,
  request = requestFor(job.id, { existing: true }),
  overrides: Partial<CronState> = {},
) {
  const state = createState(request, { cronJobs: [job], ...overrides });
  startCronEdit(state, job);
  const submit = async () => {
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: job.id });
    const call = sent(request, "cron.update");
    expect(validateCronUpdateParams(call)).toBe(true);
    return call;
  };
  return { request, state, submit };
}

function cloneJob(source: CronJob, overrides: Partial<CronState> = {}) {
  const request = requestFor("clone");
  const state = createState(request, {
    cronJobs: [source],
    cronAgentId: "main",
    ...overrides,
  });
  startCronClone(state, source);
  const submit = async () => {
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const call = sent(request);
    expect(validateCronAddParams(call)).toBe(true);
    return call;
  };
  return { request, state, submit };
}

function editFields(stored: Partial<CronJob>, form: Partial<CronState["cronForm"]> = {}) {
  const harness = editJob(makeJob(stored));
  Object.assign(harness.state.cronForm, form);
  return harness;
}

function agentPayload(overrides: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>> = {}) {
  return { kind: "agentTurn", message: "run", ...overrides } as const;
}

function makeJob(overrides: Partial<CronJob> = {}) {
  return createCronJob("job", "Job", overrides);
}

function revisionConflict() {
  return Object.assign(new Error("cron job definition changed"), {
    details: { code: "CRON_JOB_CHANGED" },
  });
}

const requireRecord = createRequireRecord("record", "expected-label-record");
const hiddenPolicy = {
  toolsAllow: ["read"],
  fallbacks: [],
  allowUnsafeExternalContent: true,
  lightContext: false,
  toolsAllowIsDefault: true,
};

it("preserves an explicit zero timeout in the saved payload", async () => {
  const { call, result } = await newJob("no-timeout", { timeoutSeconds: "0" }).submit();
  expect(result).toEqual({ saved: true, jobId: "no-timeout" });
  expect(call.payload).toMatchObject({ kind: "agentTurn", timeoutSeconds: 0 });
});

function patchOf(call: Record<string, unknown>) {
  return requireRecord(call.patch, "cron.update patch");
}

function sent(request: ReturnType<typeof createMethodRequest>, method = "cron.add") {
  const call = request.mock.calls.find(([name]) => name === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return requireRecord(call[1], `${method} payload`);
}

it.each([
  [
    { model: "openai/gpt-5.5", thinking: "high", timeoutSeconds: 0 },
    { payloadModel: "", payloadThinking: "", timeoutSeconds: "" },
    { model: null, thinking: null, timeoutSeconds: null },
  ],
  [hiddenPolicy, { description: "Metadata changed" }, { lightContext: false }],
] as const)(
  "edits payload overrides without copying authority: %j",
  async (stored, form, expected) => {
    const payload = agentPayload(stored);
    const job = createCronJob("payload", "Payload", { payload });
    const original = structuredClone(job);
    const { state, submit } = editJob(job);
    Object.assign(state.cronForm, form);
    expect(patchOf(await submit()).payload).toEqual({
      kind: "agentTurn",
      message: "run",
      ...expected,
    });
    expect(job).toEqual(original);
  },
);

it("saves exact event timing and clears its owner", async () => {
  const { submit } = editFields(
    {},
    {
      clearAgent: true,
      scheduleExact: true,
      payloadKind: "systemEvent",
      payloadText: "updated",
    },
  );
  const patch = patchOf(await submit());
  expect(patch).toMatchObject({
    agentId: null,
    schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
    payload: { kind: "systemEvent", text: "updated" },
    delivery: { mode: "none" },
  });
  expect(patch).not.toHaveProperty("deleteAfterRun");
});

it("clears persisted delivery routing", async () => {
  const { submit } = editFields(
    {
      delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "ops" },
    },
    { deliveryChannel: "last", deliveryTo: " ", deliveryAccountId: " " },
  );
  expect(patchOf(await submit()).delivery).toMatchObject({
    mode: "announce",
    channel: "last",
    to: null,
    accountId: null,
  });
});

it.each([
  [0, "0"],
  [Number.MAX_SAFE_INTEGER, "9007199254740.991"],
] as const)("round trips a %s ms cooldown through the form", async (cooldownMs, seconds) => {
  const { state, submit } = editFields({ failureAlert: { cooldownMs } });
  expect(state.cronForm.failureAlertCooldownSeconds).toBe(seconds);
  state.cronForm.description = "Metadata changed";
  expect(patchOf(await submit()).failureAlert).toMatchObject({
    cooldownMs,
  });
});

it("submits webhook delivery and resets the form", async () => {
  const { state, submit } = newJob("Webhook", {
    deliveryMode: "webhook",
    deliveryTo: "https://example.invalid/cron",
  });
  const { call, result } = await submit();
  expect(result).toEqual({ saved: true, jobId: "Webhook" });
  expect(call.delivery).toMatchObject({ mode: "webhook", to: "https://example.invalid/cron" });
  expect(state.cronForm.deliveryMode).toBe("none");
});

it("requires a loaded config revision before form saves and toggles", async () => {
  const job = makeJob({ configRevision: undefined });
  const request = vi.fn(async () => {
    throw new Error("unguarded mutation should not be issued");
  });
  const saveState = createState(request, { cronJobs: [job] });
  startCronEdit(saveState, job);
  saveState.cronForm.name = "Unsafe edit";
  await expect(addCronJob(saveState)).resolves.toEqual({ saved: false });
  expect(saveState).toMatchObject({
    cronJobs: [job],
    cronEditingJob: job,
    cronForm: { name: "Unsafe edit" },
  });
  expect(saveState.cronError).toContain("configuration revision");
  expect(request).not.toHaveBeenCalled();

  const toggleState = createState(request, { cronJobs: [job] });
  await expect(toggleCronJob(toggleState, job, false)).resolves.toBe(false);
  expect(toggleState.cronError).toContain("configuration revision");
  expect(request).not.toHaveBeenCalled();
});

it("keeps the draft's frozen revision when exact conflict recovery fails", async () => {
  const stale = makeJob({ configRevision: "stale" });
  const current = { ...stale, name: "Current", configRevision: "current" };
  const firstList = createDeferred<CronJobsListResult>();
  const list = vi
    .fn()
    .mockReturnValueOnce(firstList.promise)
    .mockResolvedValue(jobsPage([current]));
  const revisions: unknown[] = [];
  const request = createMethodRequest(
    { "cron.status": { enabled: true, jobs: 1 } },
    {
      "cron.update": (payload) => {
        revisions.push(requireRecord(payload, "update").expectedConfigRevision);
        throw revisionConflict();
      },
      "cron.list": list,
      "cron.get": () => {
        throw new Error("Exact refresh unavailable");
      },
    },
  );
  const { state } = editJob(stale, request);
  state.cronForm.name = "Unsaved";
  const pending = loadCronJobsPage(state, { tableFilters: true });
  expect(await addCronJob(state)).toEqual({ saved: false });
  expect(state).toMatchObject({
    cronForm: { name: "Unsaved" },
    cronEditingJob: { configRevision: "stale" },
  });
  expect(state.cronError).toContain("could not be loaded");
  firstList.resolve(jobsPage([current]));
  await pending;
  expect(state).toMatchObject({
    cronJobs: [current],
    cronForm: { name: "Unsaved" },
    cronEditingJob: { configRevision: "stale" },
  });
  expect(await addCronJob(state)).toEqual({ saved: false });
  expect(revisions).toEqual(["stale", "stale"]);
});

it("commits authoritative toggle state and advances an open editor revision", async () => {
  const loadedJob = makeJob({ configRevision: "revision-loaded" });
  const updatedJob = {
    ...loadedJob,
    enabled: false,
    configRevision: "revision-toggled",
  };
  const listResponse = createDeferred<CronJobsListResult>();
  const request = createMethodRequest({
    "cron.update": updatedJob,
    "cron.list": listResponse.promise,
    "cron.status": { enabled: true, jobs: 1 },
  });
  const { state } = editJob(loadedJob, request);
  state.cronForm.name = "Unsaved rename";

  const toggle = toggleCronJob(state, loadedJob, false);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.list", expect.anything()));
  expect(sent(request, "cron.update")).toMatchObject({
    id: loadedJob.id,
    expectedConfigRevision: "revision-loaded",
    patch: { enabled: false },
  });
  expect(state).toMatchObject({
    cronJobs: [updatedJob],
    cronEditingJob: updatedJob,
    cronForm: { name: "Unsaved rename" },
  });

  listResponse.resolve(jobsPage([updatedJob]));
  await expect(toggle).resolves.toBe(true);
  await addCronJob(state);
  const updateCalls = request.mock.calls.filter(([method]) => method === "cron.update");
  expect(updateCalls[1]?.[1]).toMatchObject({
    expectedConfigRevision: "revision-toggled",
    patch: { name: "Unsaved rename" },
  });
});

it("removes confirmed jobs locally before a failed reconciliation", async () => {
  const removedJob = makeJob();
  const remainingJob = createCronJob("job-remaining", "Keep locally");
  const request = createMethodRequest(
    {
      "cron.remove": { ok: true, removed: true },
      "cron.status": { enabled: true, jobs: 1 },
    },
    {
      "cron.list": () => {
        throw new Error("reconciliation unavailable");
      },
    },
  );
  const { state } = editJob(removedJob, request, {
    cronJobs: [removedJob, remainingJob],
    cronJobsTotal: 2,
    cronRunsJobId: removedJob.id,
    cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
  });
  await removeCronJob(state, removedJob);
  expect(state).toMatchObject({
    cronJobs: [remainingJob],
    cronJobsTotal: 1,
    cronEditingJob: null,
    cronRunsJobId: null,
    cronRuns: [],
  });
});

it.each<[Partial<CronState["cronForm"]>, string, unknown]>([
  [
    { scheduleKind: "cron", cronExpr: "0 * * * *", staggerAmount: "0x10" },
    "schedule",
    { kind: "cron", expr: "0 * * * *", staggerMs: 16_000 },
  ],
  [
    { failureAlertMode: "custom", failureAlertCooldownSeconds: "1e-3" },
    "failureAlert",
    expect.objectContaining({ cooldownMs: 1 }),
  ],
])("serializes numeric form input %j", async (form, field, expected) => {
  const { call, result } = await newJob("numeric", form).submit();
  expect(result.saved).toBe(true);
  expect(validateCronAddParams(call)).toBe(true);
  expect(call[field]).toEqual(expected);
});

it("requires an explicit clear before saving an existing script payload with a condition trigger", async () => {
  const job = makeJob({
    schedule: { kind: "every", everyMs: 30_000 },
    payload: { kind: "script", script: "json({ state: {} })" },
    trigger: { script: "json({ fire: true })" },
  });
  const { request, state, submit } = editJob(job);
  expect(state.cronForm.triggerEnabled).toBe(true);
  expect(await addCronJob(state)).toEqual({ saved: false });
  expect(state.cronFieldErrors.triggerScript).toBe("cron.errors.triggerScriptPayloadUnsupported");
  expect(request).not.toHaveBeenCalled();

  state.cronForm.triggerEnabled = false;
  const call = await submit();
  expect(patchOf(call).trigger).toBeNull();
  expect(patchOf(call)).not.toHaveProperty("payload");
});

it("clears stored alert routing without losing skipped-run policy", async () => {
  const job = createCronJob("alerts", "Alerts", {
    failureAlert: { channel: "telegram", to: "123", accountId: "bot", includeSkipped: true },
  });
  const { state, submit } = editJob(job);
  Object.assign(state.cronForm, {
    failureAlertChannel: "last",
    failureAlertTo: "",
    failureAlertAccountId: "",
  });
  expect(patchOf(await submit()).failureAlert).toMatchObject({
    channel: "last",
    to: null,
    accountId: null,
    includeSkipped: true,
  });
});

it.each`
  form                                                                                                            | field                            | error
  ${{ scheduleKind: "cron", staggerAmount: "8640000000000.001", staggerUnit: "seconds" }}                         | ${"staggerAmount"}               | ${"cron.errors.staggerAmountInvalid"}
  ${{ scheduleKind: "cron", staggerAmount: "0.0001" }}                                                            | ${"staggerAmount"}               | ${"cron.errors.staggerAmountInvalid"}
  ${{ timeoutSeconds: "Infinity" }}                                                                               | ${"timeoutSeconds"}              | ${"cron.errors.timeoutInvalid"}
  ${{ everyAmount: "0x10" }}                                                                                      | ${"everyAmount"}                 | ${"cron.errors.everyAmountInvalid"}
  ${{ everyAmount: "29.999", everyUnit: "seconds", triggerEnabled: true, triggerScript: "json({ fire: true })" }} | ${"everyAmount"}                 | ${"cron.errors.triggerIntervalTooShort"}
  ${{ failureAlertMode: "custom", failureAlertAfter: ".5" }}                                                      | ${"failureAlertAfter"}           | ${"Failure alert threshold must be at least 1."}
  ${{ failureAlertMode: "custom", failureAlertCooldownSeconds: "1e308" }}                                         | ${"failureAlertCooldownSeconds"} | ${"Cooldown must be finite and 0 or greater."}
`("rejects invalid $field before RPC", async ({ form, field, error }: Rejection) => {
  const { state, request } = newJob("invalid", form);
  expect(await addCronJob(state)).toEqual({ saved: false });
  expect(state.cronFieldErrors).toHaveProperty(field, error);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["systemEvent", agentPayload(hiddenPolicy), undefined],
  [
    "agentTurn",
    { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
    { script: "return { fire: true }", once: false },
  ],
] satisfies Array<["agentTurn" | "systemEvent", CronJob["payload"], CronJob["trigger"]]>)(
  "clones to %s without inheriting payload authority",
  async (target, payload, trigger) => {
    const source = makeJob({ schedule: { kind: "every", everyMs: 60_000 }, payload, trigger });
    const original = structuredClone(source);
    const { request, state, submit } = cloneJob(source);
    if (payload.kind === "command") {
      expect(state.cronForm.payloadText).toBe("");
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
      expect(request).not.toHaveBeenCalled();
    }
    Object.assign(state.cronForm, {
      payloadKind: target,
      sessionTarget: target === "systemEvent" ? "main" : "isolated",
      payloadText: "New task",
    });
    const submitted = await submit();
    expect(source).toEqual(original);
    expect(submitted.trigger).toEqual(trigger);
    expect(submitted.payload).toEqual({
      kind: target,
      ...(target === "systemEvent" ? { text: "New task" } : { message: "New task" }),
      toolsAllow: payload.toolsAllow,
    });
  },
);

it.each([
  { schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 60_000 } },
  { schedule: { kind: "on-exit", command: "make build", cwd: "/repo" } },
  {
    failureAlert: {
      after: 4,
      cooldownMs: 1_001,
      mode: "webhook",
      to: "https://alerts.example.test/cron",
      accountId: "bot-a",
      includeSkipped: true,
    },
  },
  { failureAlert: { channel: "last", includeSkipped: false } },
  { failureAlert: false },
] as const)("clones exact persisted fields: %j", async (fields) => {
  const sourceJob = createCronJob("source", "Source", { ...fields, agentId: "writer" });
  const { submit } = cloneJob(sourceJob, {
    cronJobs: "schedule" in fields ? [sourceJob] : [],
  });
  const payload = await submit();
  expect(payload.agentId).toBe("writer");
  expect(payload.name).toBe("Source copy");
  for (const [field, expected] of Object.entries(fields)) {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify omitted fields on the wire
    expect(JSON.parse(JSON.stringify(payload[field]))).toEqual(expected);
  }
});

it("round-trips hidden delivery destinations through clone and edit", async () => {
  const sourceJob = createCronJob("job-routing", "Routed job", {
    sessionKey: "agent:ops:main",
    delivery: {
      mode: "announce",
      accountId: "ops-bot",
      threadId: 42,
      bestEffort: true,
      completionDestination: { mode: "webhook", to: "https://example.test/complete" },
      failureDestination: { mode: "announce", to: "ops" },
    },
  });

  const addPayload = await cloneJob(sourceJob).submit();
  expect(addPayload.delivery).toEqual(sourceJob.delivery);
  expect(addPayload.sessionKey).toBe("agent:ops:main");

  const { state, submit } = editJob(sourceJob);
  state.cronForm.deliveryThreadId = "thread-42";
  expect(patchOf(await submit()).delivery).toEqual({
    ...sourceJob.delivery,
    threadId: "thread-42",
  });
});

it("reads intervals into the largest exact unit without rounding", () => {
  for (const [everyMs, amount, unit] of [
    [1, "0.001", "seconds"],
    [60_000, "1", "minutes"],
    [7_200_000, "2", "hours"],
    [86_400_000, "1", "days"],
    [8_639_999_999_999_999, "8639999999999.999", "seconds"],
  ] as const) {
    const { state } = editJob(makeJob({ schedule: { kind: "every", everyMs } }));
    expect(state.cronForm.everyUnit).toBe(unit);
    expect(state.cronForm.everyAmount).toBe(amount);
    expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(everyMs);
  }
});

it("omits an unchanged minute but sends a genuinely changed minute", async () => {
  const originalAt = new Date(2030, 0, 2, 3, 4, 56, 789).toISOString();
  const original = makeJob({
    schedule: { kind: "at", at: originalAt },
    deleteAfterRun: true,
  });

  const unchanged = editJob(original);
  unchanged.state.cronForm.description = "metadata only";
  expect(patchOf(await unchanged.submit())).not.toHaveProperty("schedule");

  const changed = editJob(original);
  changed.state.cronForm.scheduleAt = "2030-01-02T03:05";
  expect(patchOf(await changed.submit()).schedule).toEqual({
    kind: "at",
    at: new Date(2030, 0, 2, 3, 5).toISOString(),
  });
});

it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
  const { submit } = editFields(
    { payload: { kind: "command", argv: ["node", "report.mjs"] }, failureAlert: {} },
    { description: "Only metadata changed" },
  );
  const patch = patchOf(await submit());
  expect(patch).not.toHaveProperty("payload");
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- hidden controls must not materialize defaults on the wire
  expect(JSON.parse(JSON.stringify(patch.failureAlert))).toEqual({});
});
