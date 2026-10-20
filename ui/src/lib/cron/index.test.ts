// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult, CronRunsResult } from "../../api/types.ts";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import {
  addCronJob,
  cancelCronEdit,
  toggleCronJob,
  invalidateCronRefresh,
  loadCronJobsPage,
  loadCronScopeStats,
  removeCronJob,
  runCronJob,
  startCronEdit,
  startCronClone,
  updateCronJobsFilter,
} from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import {
  createCronJob,
  createCronRunsResult,
  createMethodRequest,
  createStateWithRequest,
  cronJobsListResponse,
} from "./cron.test-support.ts";
import { loadCronRuns, updateCronRunsFilter } from "./runs.ts";
import { createInitialCronState, loadCronStatus } from "./state.ts";

function createCronRequest(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob(jobId, "Existing job");
  const jobs = options.existing ? [existingJob] : [];
  return createMethodRequest({
    "cron.add": { job: { id: jobId } },
    "cron.update": existingJob,
    "cron.list": cronJobsListResponse(jobs),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  });
}

function createCronSubmitHarness(
  jobId: string,
  form: Partial<CronState["cronForm"]> = {},
  method: "cron.add" | "cron.update" = "cron.add",
) {
  const request = createCronRequest(jobId, { existing: method === "cron.update" });
  const state = createStateWithRequest(request);
  if (method === "cron.update") {
    const job = createCronJob(jobId, "Existing job");
    state.cronJobs = [job];
    startCronEdit(state, job);
  }
  state.cronForm = { ...DEFAULT_CRON_FORM, name: jobId, payloadText: "run", ...form };
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: sent(request, method), result };
  };
  return { request, state, submit };
}

function createCronEditHarness(
  job: CronJob,
  request = createCronRequest(job.id, { existing: true }),
  overrides: Partial<CronState> = {},
) {
  const state = createStateWithRequest(request, { cronJobs: [job], ...overrides });
  startCronEdit(state, job);
  const submit = async () => {
    await addCronJob(state);
    return sent(request, "cron.update");
  };
  return { request, state, submit };
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
};

function requestPatch(call: Record<string, unknown>) {
  return requireRecord(call.patch, "cron.update patch");
}

function sent(request: ReturnType<typeof createMethodRequest>, method = "cron.add") {
  const call = request.mock.calls.find(([name]) => name === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return requireRecord(call[1], `${method} payload`);
}

function runEntry(jobId: string, ts: number) {
  return { ts, jobId, action: "finished", status: "ok" } as const;
}

function createCronJobsReloadHarness(stateOverrides: Partial<CronState> = {}) {
  const first = createDeferred<CronJobsListResult>();
  const payloads: unknown[] = [];
  const request = vi.fn(async (method: string, payload?: unknown) => {
    if (method !== "cron.list") {
      return {};
    }
    payloads.push(payload);
    return payloads.length === 1 ? first.promise : cronJobsListResponse();
  });
  return {
    first,
    payloads,
    request,
    state: createStateWithRequest(request, stateOverrides),
  };
}

describe("cron controller", () => {
  it("preserves an explicit zero timeout in the saved payload", async () => {
    const { call, result } = await createCronSubmitHarness(
      "no-timeout",
      {
        payloadText: "Run until complete",
        timeoutSeconds: "0",
      },
      "cron.update",
    ).submit();
    expect(result).toEqual({ saved: true, jobId: "no-timeout" });
    expect(requestPatch(call).payload).toEqual({
      kind: "agentTurn",
      message: "Run until complete",
      timeoutSeconds: 0,
    });
  });

  it.each([
    {
      name: "Webhook",
      form: { deliveryMode: "webhook", deliveryTo: "https://example.invalid/cron" },
      delivery: expect.objectContaining({ mode: "webhook", to: "https://example.invalid/cron" }),
    },
    {
      name: "Main event",
      form: {
        sessionTarget: "main",
        payloadKind: "systemEvent",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
      delivery: { mode: "none" },
    },
  ] as const)("submits normalized delivery for $name", async ({ name, form, delivery }) => {
    const { state, submit } = createCronSubmitHarness(name, form);
    const { call, result } = await submit();
    expect(result).toEqual({ saved: true, jobId: name });
    expect(call.name).toBe(name);
    expect(call.delivery).toEqual(delivery);
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it.each([
    {
      name: "clears stored overrides including zero timeout",
      payload: {
        kind: "agentTurn",
        message: "do work",
        model: "openai/gpt-5.5",
        thinking: "high",
        timeoutSeconds: 0,
      },
      before: { timeoutSeconds: "0" },
      form: { payloadModel: "", payloadThinking: "", timeoutSeconds: "" },
      expected: {
        kind: "agentTurn",
        message: "do work",
        model: null,
        thinking: null,
        timeoutSeconds: null,
      },
    },
    {
      name: "leaves hidden policy under Gateway authority",
      payload: {
        kind: "agentTurn",
        message: "Synthetic task",
        ...hiddenPolicy,
        toolsAllowIsDefault: true,
      },
      before: { timeoutSeconds: "" },
      form: { description: "Metadata changed" },
      expected: { kind: "agentTurn", message: "Synthetic task", lightContext: false },
    },
  ] as const)("edit payload: $name", async ({ payload, before, form, expected }) => {
    const source = createCronJob("payload", "Payload", { payload });
    const original = structuredClone(source);
    const { state, submit } = createCronEditHarness(source);
    expect(state.cronForm).toMatchObject(before);
    Object.assign(state.cronForm, form);
    const call = await submit();
    expect(validateCronUpdateParams(call)).toBe(true);
    expect(requestPatch(call).payload).toEqual(expected);
    expect(source).toEqual(original);
  });

  it("saves exact timing and explicit owner clearing in an event update", async () => {
    const { state, submit } = createCronEditHarness(createCronJob("job", "Event"));
    Object.assign(state.cronForm, {
      clearAgent: true,
      scheduleExact: true,
      payloadKind: "systemEvent",
      payloadText: "updated",
    });
    const patch = requestPatch(await submit());
    expect(patch).toMatchObject({
      agentId: null,
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
      payload: { kind: "systemEvent", text: "updated" },
      delivery: { mode: "none" },
    });
    expect(patch).not.toHaveProperty("deleteAfterRun");
  });

  it("requires a loaded config revision before form saves and toggles", async () => {
    const job = createCronJob("job-missing-revision", "Missing revision", {
      configRevision: undefined,
    });
    const request = vi.fn(async () => {
      throw new Error("unguarded mutation should not be issued");
    });
    const saveState = createStateWithRequest(request, { cronJobs: [job] });
    startCronEdit(saveState, job);
    saveState.cronForm.name = "Unsafe edit";

    await expect(addCronJob(saveState)).resolves.toEqual({ saved: false });
    expect(saveState.cronEditingJob?.id).toBe(job.id);
    expect(saveState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();

    const toggleState = createStateWithRequest(request, { cronJobs: [job] });
    await expect(toggleCronJob(toggleState, job, false)).resolves.toBe(false);
    expect(toggleState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();
  });

  it("reloads a conflicted definition without adding it to filtered results", async () => {
    const stale = createCronJob("conflict", "Loaded", { configRevision: "stale" });
    const current = {
      ...stale,
      name: "Current",
      description: "Latest definition",
      configRevision: "current",
    };
    const saved = { ...current, name: "Retried", configRevision: "saved" };
    const updates = vi.fn(async (_payload?: unknown) => saved);
    updates.mockRejectedValueOnce(revisionConflict());
    const request = createMethodRequest(
      {
        "cron.list": cronJobsListResponse(),
        "cron.get": current,
        "cron.status": { enabled: true, jobs: 1 },
      },
      { "cron.update": updates },
    );
    const { state } = createCronEditHarness(stale, request, { cronJobsQuery: "filtered" });
    state.cronForm.name = "Unsaved";
    state.cronJobs = [current];
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "filtered" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: stale.id });
    expect(state).toMatchObject({
      cronJobs: [],
      cronJobsTotal: 0,
      cronEditingJob: current,
      cronForm: { name: "Current", description: "Latest definition" },
    });
    state.cronForm.name = "Retried";
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: stale.id });
    expect(
      updates.mock.calls.map(
        ([payload]) => requireRecord(payload, "update").expectedConfigRevision,
      ),
    ).toEqual(["stale", "current"]);
    expect(state.cronJobs).toEqual([]);
    expect(state.cronEditingJob).toEqual(saved);
  });

  it("keeps the draft's frozen revision when exact conflict recovery fails", async () => {
    const stale = createCronJob("conflict", "Loaded", { configRevision: "stale" });
    const current = { ...stale, name: "Current", configRevision: "current" };
    const firstList = createDeferred<CronJobsListResult>();
    const list = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockResolvedValue(cronJobsListResponse([current]));
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
    const { state } = createCronEditHarness(stale, request);
    state.cronForm.name = "Unsaved";
    const pending = loadCronJobsPage(state, { tableFilters: true });
    expect(list).toHaveBeenCalledOnce();
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronForm.name).toBe("Unsaved");
    expect(state.cronEditingJob?.configRevision).toBe("stale");
    expect(state.cronError).toContain("could not be loaded");
    firstList.resolve(cronJobsListResponse([current]));
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
    const loadedJob = createCronJob("job-authoritative-toggle", "Toggle job", {
      enabled: true,
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      enabled: false,
      updatedAtMs: 2,
      configRevision: "revision-toggled",
    };
    const listResponse = createDeferred<CronJobsListResult>();
    const request = createMethodRequest({
      "cron.update": updatedJob,
      "cron.list": listResponse.promise,
      "cron.status": { enabled: true, jobs: 1 },
    });
    const { state } = createCronEditHarness(loadedJob, request);
    state.cronForm.name = "Unsaved rename";

    const toggle = toggleCronJob(state, loadedJob, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.list", expect.anything()));

    expect(request).toHaveBeenCalledWith("cron.update", {
      id: loadedJob.id,
      expectedConfigRevision: "revision-loaded",
      patch: { enabled: false },
    });
    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
    expect(state.cronForm.name).toBe("Unsaved rename");

    listResponse.resolve(cronJobsListResponse([updatedJob]));
    await expect(toggle).resolves.toBe(true);

    await addCronJob(state);
    const updateCalls = request.mock.calls.filter(([method]) => method === "cron.update");
    expect(updateCalls[1]?.[1]).toMatchObject({
      expectedConfigRevision: "revision-toggled",
      patch: { name: "Unsaved rename" },
    });
  });

  it("removes confirmed jobs locally before a failed reconciliation", async () => {
    const removedJob = createCronJob("job-remove-local", "Remove locally");
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
    const { state } = createCronEditHarness(removedJob, request, {
      cronJobs: [removedJob, remainingJob],
      cronJobsTotal: 2,
      cronRunsJobId: removedJob.id,
      cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
      cronRunsTotal: 1,
    });

    await removeCronJob(state, removedJob);

    expect(state.cronJobs).toEqual([remainingJob]);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([]);
  });

  it("clears persisted delivery routing when its inputs are blanked", async () => {
    const job = createCronJob("clear-routing", "Routed job", {
      delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "ops" },
    });
    const { state, submit } = createCronEditHarness(job);
    Object.assign(state.cronForm, {
      deliveryChannel: "last",
      deliveryTo: " ",
      deliveryAccountId: " ",
    });
    expect(requestPatch(await submit()).delivery).toMatchObject({
      mode: "announce",
      channel: "last",
      to: null,
      accountId: null,
    });
  });

  it("requires an explicit delivery choice before editing an unknown persisted mode", async () => {
    const job = createCronJob("legacy-delivery", "Garden summary", {
      delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
    });
    Reflect.set(job.delivery!, "mode", "unknown");
    const original = structuredClone(job);
    const { request, state } = createCronEditHarness(job);
    state.cronForm.name = "Renamed garden summary";
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    expect(job).toEqual(original);
    expect(state.cronFieldErrors.deliveryMode).toBe("cron.errors.deliveryModeRequired");

    state.cronForm.deliveryMode = "announce";
    expect(await addCronJob(state)).toMatchObject({ saved: true, jobId: job.id });
    const patch = requestPatch(sent(request, "cron.update"));
    expect(patch).toMatchObject({
      name: "Renamed garden summary",
      delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
    });
    expect(validateCronUpdateParams(sent(request, "cron.update"))).toBe(true);
  });

  it("preserves configured duration precision when editing a staggered cron expression", async () => {
    const job = createCronJob("job-exact-stagger", "Exact stagger", {
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 1_001 },
    });
    const { state, submit } = createCronEditHarness(job);
    const displayedAmount = state.cronForm.staggerAmount;
    state.cronForm.cronExpr = "*/5 * * * *";

    const call = await submit();

    expect({ displayedAmount, schedule: requestPatch(call).schedule }).toEqual({
      displayedAmount: "1.001",
      schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 1_001 },
    });
    expect(validateCronUpdateParams(call)).toBe(true);
  });

  it("accepts prefixed-number stagger input", async () => {
    const { call, result } = await createCronSubmitHarness("stagger", {
      scheduleKind: "cron",
      cronExpr: "0 * * * *",
      staggerAmount: "0x10",
      staggerUnit: "seconds",
    }).submit();
    expect(result.saved).toBe(true);
    expect(call.schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      staggerMs: 16_000,
    });
    expect(validateCronAddParams(call)).toBe(true);
  });

  it("preserves the trigger draft and inventory when its syntax is rejected", async () => {
    const job = createCronJob("syntax", "Conditional job", {
      trigger: { script: "return { fire: true }" },
    });
    const { request, state } = createCronEditHarness(job);
    state.cronForm.triggerScript = "const x = ;";
    request.mockRejectedValue(new Error("Invalid trigger syntax"));
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronError).toBe("Invalid trigger syntax");
    expect(state.cronForm.triggerScript).toBe("const x = ;");
    expect(state.cronJobs).toEqual([job]);
    expect(state.cronEditingJob).toBe(job);
  });

  it("requires an explicit clear before saving an existing script payload with a condition trigger", async () => {
    const job = createCronJob("job-script-trigger-conflict", "Conflicting script", {
      schedule: { kind: "every", everyMs: 30_000 },
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
    });
    const { request, state, submit } = createCronEditHarness(job);

    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.triggerScript).toBe("cron.errors.triggerScriptPayloadUnsupported");
    expect(request).not.toHaveBeenCalled();

    state.cronForm.triggerEnabled = false;
    const call = await submit();

    expect(requestPatch(call).trigger).toBeNull();
    expect(requestPatch(call)).not.toHaveProperty("payload");
  });

  it.each([
    [
      "custom",
      {
        channel: "last",
        mode: null,
        includeSkipped: true,
        after: null,
        to: null,
        cooldownMs: null,
        accountId: null,
      },
    ],
    ["inherit", null],
  ] as const)("clears persisted failure alert overrides with %s", async (mode, expected) => {
    const job = createCronJob("job-clear-alert-fields", "Clear failure alert fields", {
      delivery: { mode: "announce" },
      failureAlert: {
        after: 2,
        channel: "telegram",
        to: "123456",
        cooldownMs: 60_000,
        accountId: "bot-a",
        mode: "webhook",
        includeSkipped: true,
      },
    });
    const { state, submit } = createCronEditHarness(job);

    const blankAlerts = Object.fromEntries(
      Object.entries(DEFAULT_CRON_FORM).filter(([field]) => field.startsWith("failureAlert")),
    );
    Object.assign(state.cronForm, blankAlerts, { failureAlertMode: mode });
    const call = await submit();

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify explicit clears on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual(expected);
  });

  it.each<[Partial<CronState["cronForm"]>, string, string]>([
    [
      { scheduleKind: "cron", staggerAmount: "8640000000000.001", staggerUnit: "seconds" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [
      { scheduleKind: "cron", staggerAmount: "0.0001" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [{ timeoutSeconds: "Infinity" }, "timeoutSeconds", "cron.errors.timeoutInvalid"],
    [{ everyAmount: "0x10" }, "everyAmount", "cron.errors.everyAmountInvalid"],
    [
      {
        everyAmount: "29.999",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      "everyAmount",
      "cron.errors.triggerIntervalTooShort",
    ],
    [
      { failureAlertMode: "custom", failureAlertAfter: ".5" },
      "failureAlertAfter",
      "Failure alert threshold must be at least 1.",
    ],
    [
      { failureAlertMode: "custom", failureAlertCooldownSeconds: "1e308" },
      "failureAlertCooldownSeconds",
      "Cooldown must be finite and 0 or greater.",
    ],
  ])("rejects invalid numeric input %j before RPC", async (form, field, error) => {
    const { state, request } = createCronSubmitHarness("invalid", form);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors).toHaveProperty(field, error);
    expect(request).not.toHaveBeenCalled();
  });

  it("clones deny-all payload policy without its capture marker", async () => {
    const policy = {
      ...hiddenPolicy,
      toolsAllow: [],
      allowUnsafeExternalContent: false,
      toolsAllowIsDefault: true,
    };
    const source = createCronJob("source", "Policy source", {
      agentId: "writer",
      payload: { kind: "agentTurn", message: "Synthetic task", ...policy },
    });
    const original = structuredClone(source);
    const request = createCronRequest("clone");
    const state = createStateWithRequest(request, { cronJobs: [source], cronAgentId: "main" });
    startCronEdit(state, source);
    startCronClone(state, source);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const submitted = sent(request);
    expect(submitted.name).toBe("Policy source copy");
    expect(submitted.agentId).toBe("writer");
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    const expected: Extract<CronJob["payload"], { kind: "agentTurn" }> = {
      kind: "agentTurn",
      message: "Synthetic task",
      ...policy,
    };
    delete expected.toolsAllowIsDefault;
    expect(submitted.payload).toEqual(expected);
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
  });

  it.each([
    [
      "agent task to system event",
      { kind: "agentTurn", message: "Original task", ...hiddenPolicy },
      undefined,
      "systemEvent",
    ],
    [
      "command to new agent task",
      { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
      { script: "return { fire: true }", once: false },
      "agentTurn",
    ],
  ] satisfies Array<[string, CronJob["payload"], CronJob["trigger"], "agentTurn" | "systemEvent"]>)(
    "clone payload policy: retains common restrictions for %s",
    async (_name, payload, trigger, target) => {
      const source = createCronJob("kind-source", "Kind transition source", {
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload,
        trigger,
      });
      const original = structuredClone(source);
      const request = createCronRequest("kind-clone");
      const state = createStateWithRequest(request, { cronJobs: [source] });
      startCronClone(state, source);
      if (payload.kind === "command") {
        expect(state.cronForm.payloadText).toBe("");
        expect(await addCronJob(state)).toEqual({ saved: false });
        expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
        expect(request).not.toHaveBeenCalled();
      }
      Object.assign(state.cronForm, {
        payloadKind: target,
        sessionTarget: target === "systemEvent" ? "main" : "isolated",
        payloadText: "New operator-authored task",
      });

      expect(await addCronJob(state)).toEqual({ saved: true, jobId: "kind-clone" });

      const submitted = sent(request);
      expect(validateCronAddParams(submitted)).toBe(true);
      expect(source).toEqual(original);
      expect(submitted.trigger).toEqual(trigger);
      expect(submitted.payload).toEqual({
        kind: target,
        ...(target === "systemEvent"
          ? { text: "New operator-authored task" }
          : { message: "New operator-authored task" }),
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
    const request = createCronRequest("clone");
    const sourceJob = createCronJob("source", "Source", fields);
    const state = createStateWithRequest(request, {
      cronJobs: "schedule" in fields ? [sourceJob] : [],
    });
    startCronClone(state, sourceJob);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const payload = sent(request);
    expect(validateCronAddParams(payload)).toBe(true);
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
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "ops",
          accountId: "alerts",
        },
      },
    });

    const addRequest = createCronRequest("job-copy");
    const cloneState = createStateWithRequest(addRequest, { cronJobs: [sourceJob] });
    startCronClone(cloneState, sourceJob);
    await addCronJob(cloneState);
    const addPayload = sent(addRequest);
    expect(addPayload.delivery).toEqual(sourceJob.delivery);
    expect(addPayload.sessionKey).toBe("agent:ops:main");
    expect(validateCronAddParams(addPayload)).toBe(true);

    const { request: updateRequest, state: editState } = createCronEditHarness(sourceJob);
    editState.cronForm.deliveryThreadId = "thread-42";
    await addCronJob(editState);
    const updatePayload = sent(updateRequest, "cron.update");
    expect(requireRecord(updatePayload.patch, "cron.update patch").delivery).toEqual({
      ...sourceJob.delivery,
      threadId: "thread-42",
    });
    expect(validateCronUpdateParams(updatePayload)).toBe(true);
  });

  it("appends jobs only from the accepted snapshot revision", async () => {
    const firstJob = createCronJob("job-1", "First");
    const secondJob = createCronJob("job-2", "Second");
    const request = vi.fn(async () =>
      cronJobsListResponse([secondJob], {
        snapshotRevision: "stable-revision",
        total: 2,
        offset: 1,
        limit: 1,
      }),
    );
    const state = createStateWithRequest(request, {
      cronJobs: [firstJob],
      cronJobsSnapshotRevision: "stable-revision",
      cronJobsTotal: 2,
      cronJobsHasMore: true,
      cronJobsNextOffset: 1,
      cronJobsLimit: 1,
    });

    await loadCronJobsPage(state, { append: true });

    expect(state.cronJobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(state.cronJobsSnapshotRevision).toBe("stable-revision");
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("restarts at page zero instead of committing an append from a changed snapshot", async () => {
    const staleJob = createCronJob("stale-only", "Stale");
    const stableJob = createCronJob("stable", "Stable");
    const currentJob = createCronJob("current", "Current");
    const responses = [
      cronJobsListResponse([staleJob, stableJob], {
        snapshotRevision: "revision-a",
        total: 3,
        limit: 2,
        hasMore: true,
        nextOffset: 2,
      }),
      cronJobsListResponse([], {
        snapshotRevision: "revision-b",
        total: 2,
        offset: 2,
        limit: 2,
      }),
      cronJobsListResponse([stableJob, currentJob], {
        snapshotRevision: "revision-b",
        total: 2,
        limit: 2,
      }),
    ];
    const offsets: number[] = [];
    const request = vi.fn(async (_method: string, payload?: unknown) => {
      offsets.push(requireRecord(payload, "cron.list payload").offset as number);
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected cron.list call");
      }
      return response;
    });
    const state = createStateWithRequest(request, { cronJobsLimit: 2 });

    await loadCronJobsPage(state);
    await loadCronJobsPage(state, { append: true });

    expect(offsets).toEqual([0, 2, 0]);
    expect(state.cronJobs.map((job) => job.id)).toEqual(["stable", "current"]);
    expect(state.cronJobsSnapshotRevision).toBe("revision-b");
    expect(state.cronJobsTotal).toBe(2);
    expect(state.cronJobsHasMore).toBe(false);
    expect(state.cronJobsNextOffset).toBeNull();
  });

  it("retains the last coherent page when snapshot metadata is invalid", async () => {
    const job = createCronJob("existing", "Existing");
    const request = createMethodRequest({
      "cron.list": { ...cronJobsListResponse(), snapshotRevision: undefined },
    });
    const state = createStateWithRequest(request, {
      cronJobs: [job],
      cronJobsSnapshotRevision: "accepted",
      cronJobsTotal: 1,
    });
    await loadCronJobsPage(state);
    expect(state).toMatchObject({
      cronJobs: [job],
      cronJobsSnapshotRevision: "accepted",
      cronJobsTotal: 1,
      cronError: null,
    });
    expect(state.cronJobsError).toContain("cron.list returned an invalid inventory page");
  });

  it.each([true, false])("reloads with the latest table-filter mode %s", async (tableFilters) => {
    const { first, payloads, request, state } = createCronJobsReloadHarness(
      tableFilters
        ? {
            cronJobsSnapshotRevision: "revision-a",
            cronJobsTotal: 2,
            cronJobsHasMore: true,
            cronJobsNextOffset: 1,
          }
        : { cronJobsScheduleKindFilter: "cron", cronJobsLastStatusFilter: "unknown" },
    );
    const pending = loadCronJobsPage(state, { append: tableFilters, tableFilters });
    updateCronJobsFilter(state, {
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    if (!tableFilters) {
      await loadCronJobsPage(state);
    }
    first.resolve(
      cronJobsListResponse(
        [],
        tableFilters ? { snapshotRevision: "revision-b", total: 1, offset: 1 } : {},
      ),
    );
    await pending;
    expect(payloads[0]).toMatchObject({ offset: tableFilters ? 1 : 0 });
    expect(payloads[1]).toMatchObject({ offset: 0 });
    if (tableFilters) {
      expect(payloads[1]).toMatchObject({ scheduleKind: "cron", lastRunStatus: "unknown" });
    } else {
      for (const field of ["scheduleKind", "lastRunStatus", "trigger"]) {
        expect(payloads[1]).not.toHaveProperty(field);
      }
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({
      cronJobsReloadPending: false,
      cronJobsReloadPendingTableFilters: false,
      cronJobsSnapshotRevision: "cron-jobs-fixture",
    });
  });

  it("drops an older append after replacing history filters", async () => {
    const current = { ...runEntry("filtered", 3), status: "error" as const };
    const older = createDeferred<CronRunsResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        createCronRunsResult([runEntry("previous", 2)], { total: 2, hasMore: true, nextOffset: 1 }),
      )
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(createCronRunsResult([current]));
    const state = createStateWithRequest(request);
    await loadCronRuns(state);
    const pending = loadCronRuns(state, { append: true });
    expect(state.cronRunsLoadingMore).toBe(true);
    updateCronRunsFilter(state, { cronRunsStatuses: ["error"], cronRunsQuery: "filtered" });
    await expect(loadCronRuns(state)).resolves.toBe("ok");
    expect(state.cronRunsLoadingMore).toBe(false);
    older.resolve(
      createCronRunsResult([runEntry("stale", 1)], { total: 9, hasMore: true, nextOffset: 2 }),
    );
    await expect(pending).resolves.toBe("skipped");
    expect(state).toMatchObject({
      cronRuns: [current],
      cronRunsTotal: 1,
      cronRunsHasMore: false,
      cronRunsLoadingMore: false,
    });
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
    const state = createInitialCronState({ connected: true });
    startCronEdit(
      state,
      createCronJob("interval", "Interval", { schedule: { kind: "every", everyMs } }),
    );
    expect(state.cronForm.everyUnit).toBe(unit);
    expect(state.cronForm.everyAmount).toBe(amount);
    expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(everyMs);
  }
});

it("omits an unchanged minute but sends a genuinely changed minute", async () => {
  const originalAt = "2030-01-02T03:04:56.789Z";
  const original = createCronJob("job-at-precision", "Precise one-shot", {
    schedule: { kind: "at", at: originalAt },
    deleteAfterRun: true,
  });

  const unchanged = createCronEditHarness(original);
  unchanged.state.cronForm.description = "metadata only";
  const unchangedPatch = requestPatch(await unchanged.submit());
  expect(unchangedPatch).not.toHaveProperty("schedule");

  const changed = createCronEditHarness(original);
  const originalMinute = new Date(originalAt);
  originalMinute.setMinutes(originalMinute.getMinutes() + 1);
  originalMinute.setSeconds(0, 0);
  const localMinute = new Date(
    originalMinute.getTime() - originalMinute.getTimezoneOffset() * 60_000,
  );
  changed.state.cronForm.scheduleAt = localMinute.toISOString().slice(0, 16);
  const changedPatch = requestPatch(await changed.submit());
  expect(changedPatch.schedule).toEqual({
    kind: "at",
    at: originalMinute.toISOString(),
  });
});

it("loads independent totals and next wake time for the selected agent", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ jobs: [], total: 7 })
    .mockResolvedValueOnce({ jobs: [{ state: { nextRunAtMs: 1234 } }], total: 1 });
  const state = createStateWithRequest(request, { cronAgentId: "writer" });
  await loadCronScopeStats(state);
  expect(state).toMatchObject({ cronScopedTotal: 7, cronScopedNextWakeAtMs: 1234 });
  expect(request).toHaveBeenNthCalledWith(
    1,
    "cron.list",
    expect.objectContaining({ agentId: "writer", includeDisabled: true }),
  );
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("failure alert form round trips", () => {
  it.each([
    { cooldownMs: 0, seconds: "0" },
    { cooldownMs: Number.MAX_SAFE_INTEGER, seconds: "9007199254740.991" },
  ])(
    "preserves a $cooldownMs ms cooldown when editing metadata",
    async ({ cooldownMs, seconds }) => {
      const job = createCronJob("cooldown-metadata", "Stored cooldown", {
        failureAlert: { cooldownMs },
      });
      const { state, submit } = createCronEditHarness(job);

      expect(state.cronForm.failureAlertCooldownSeconds).toBe(seconds);
      state.cronForm.description = "Only the description changed";
      const call = await submit();

      expect(validateCronUpdateParams(call)).toBe(true);
      expect(requestPatch(call).failureAlert).toMatchObject({
        cooldownMs,
      });
    },
  );

  it("serializes cooldown seconds in exponent notation", async () => {
    const { call } = await createCronSubmitHarness("cooldown", {
      failureAlertMode: "custom",
      failureAlertCooldownSeconds: "1e-3",
    }).submit();
    expect(validateCronAddParams(call)).toBe(true);
    expect(call.failureAlert).toMatchObject({ cooldownMs: 1 });
  });

  it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
    const job = createCronJob("command-inherited-policy", "Command alert policy", {
      payload: { kind: "command", argv: ["node", "report.mjs"] },
      failureAlert: {},
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.description = "Only metadata changed";

    const call = await submit();

    expect(requestPatch(call)).not.toHaveProperty("payload");
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- hidden controls must not materialize defaults on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({});
  });
});

describe("selected automation runtime refresh", () => {
  it.each(["close and reopen", "agent", "connection", "invalidate"] as const)(
    "rejects a retained read after %s changes its owner",
    async (change) => {
      const job = createCronJob("selected", "Saved", { state: { triggerEvalCount: 1 } });
      const pending = createDeferred<CronJob>();
      const request = vi.fn(async (method: string) =>
        method === "cron.get" ? pending.promise : { enabled: true, jobs: 1 },
      );
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
      const read = loadCronStatus(state);
      expect(request).toHaveBeenCalledWith("cron.get", { id: job.id });
      if (change === "close and reopen") {
        cancelCronEdit(state, state.cronAgentId);
        startCronEdit(state, job);
      } else if (change === "agent") {
        state.cronAgentId = "other";
      } else if (change === "connection") {
        state.client = createStateWithRequest(request).client;
      } else {
        invalidateCronRefresh(state);
      }
      pending.resolve({ ...job, state: { triggerEvalCount: 99 } });
      await read;
      expect(state.cronEditingJob).toBe(job);
      expect(job.state.triggerEvalCount).toBe(1);
      expect(state.cronError).toBeNull();
    },
  );

  it.each([
    { operation: "save", method: "cron.get", readFirst: true, failWhileBusy: false },
    { operation: "run", method: "cron.status", readFirst: false, failWhileBusy: false },
    { operation: "save", method: "cron.get", readFirst: false, failWhileBusy: true },
    { operation: "toggle", method: "cron.status", readFirst: false, failWhileBusy: true },
  ] as const)(
    "preserves $operation feedback against $method (readFirst=$readFirst, failWhileBusy=$failWhileBusy)",
    async ({ operation, method: readMethod, readFirst, failWhileBusy }) => {
      const job = createCronJob("selected", "Saved", { state: {} });
      const pending = createDeferred<unknown>();
      const operationResponse = createDeferred<unknown>();
      const request = createMethodRequest({
        "cron.get": job,
        "cron.update": operationResponse.promise,
        "cron.run": operationResponse.promise,
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
        "cron.status": { enabled: true, jobs: 1 },
        [readMethod]: pending.promise,
      });
      const { state } = createCronEditHarness(job, request, { cronJobs: [] });
      const mutate = () =>
        operation === "save"
          ? addCronJob(state)
          : operation === "toggle"
            ? toggleCronJob(state, job, false)
            : runCronJob(state, job.id);
      const refresh = () => loadCronStatus(state, { coalesce: true });
      const read = readFirst ? refresh() : undefined;
      const firstQueued = readFirst ? refresh() : undefined;
      const mutation = mutate();
      const activeRead = read ?? refresh();
      expect(request).toHaveBeenCalledWith(
        readMethod,
        readMethod === "cron.get" ? { id: job.id } : {},
      );
      const queued = failWhileBusy ? Promise.resolve() : (firstQueued ?? refresh());
      if (failWhileBusy) {
        pending.reject(new Error("Background refresh failed"));
        await activeRead;
        expect(state.cronError).toBeNull();
      }
      if (operation === "run") {
        operationResponse.resolve({ ok: true, enqueued: true, runId: "queued-run" });
      } else {
        operationResponse.reject(new Error("Update rejected by Gateway"));
      }
      await mutation;
      const expectedFeedback =
        operation === "run" ? "Run queued. Run ID: queued-run" : "Update rejected by Gateway";
      expect(state.cronError).toBe(expectedFeedback);
      if (!failWhileBusy) {
        pending.reject(new Error("Older refresh failed"));
      }
      await Promise.all([activeRead, queued]);
      expect(state.cronError).toBe(expectedFeedback);
      expect(state.cronEditingJob).toBe(job);
    },
  );

  it("keeps final event data and the trailing refresh after Run now settles", async () => {
    const job = createCronJob("selected", "Saved", { state: { triggerEvalCount: 1 } });
    const runResponse = createDeferred<unknown>();
    const firstJob = createDeferred<CronJob>();
    const lastJob = createDeferred<CronJob>();
    const firstStatus = createDeferred<unknown>();
    let jobReads = 0;
    let statusReads = 0;
    const request = createMethodRequest(
      {
        "cron.run": runResponse.promise,
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
      },
      {
        "cron.get": () => (++jobReads === 1 ? firstJob.promise : lastJob.promise),
        "cron.status": () =>
          ++statusReads === 1 ? firstStatus.promise : { enabled: true, jobs: 9 },
      },
    );
    const { state } = createCronEditHarness(job, request, { cronJobs: [] });
    const mutation = runCronJob(state, job.id);
    const read = loadCronStatus(state, { coalesce: true });
    const queued = loadCronStatus(state, { coalesce: true });
    let queuedSettled = false;
    void queued.then(() => {
      queuedSettled = true;
    });
    runResponse.resolve({ ok: true, enqueued: true, runId: "queued-run" });
    await mutation;
    firstJob.resolve({ ...job, state: { triggerEvalCount: 7 } });
    firstStatus.resolve({ enabled: true, jobs: 7 });
    await read;
    expect(job.state.triggerEvalCount).toBe(7);
    expect(jobReads).toBe(2);
    expect(queuedSettled).toBe(false);
    lastJob.resolve({ ...job, state: { triggerEvalCount: 9 } });
    await queued;
    expect(job.state.triggerEvalCount).toBe(9);
    expect(state.cronStatus?.jobs).toBe(9);
    expect(state.cronError).toBe("Run queued. Run ID: queued-run");
  });

  it.each(["cron.get", "cron.status"] as const)(
    "keeps explicit reconciliation errors visible for %s with a queued event",
    async (failedMethod) => {
      const job = createCronJob("selected", "Saved", { state: {} });
      const failure = createDeferred<unknown>();
      let failedMethodReads = 0;
      const responses = {
        "cron.update": job,
        "cron.get": job,
        "cron.list": cronJobsListResponse([job]),
        "cron.status": { enabled: true, jobs: 1 },
      };
      const request = createMethodRequest(responses, {
        [failedMethod]: () =>
          ++failedMethodReads === 1 ? failure.promise : responses[failedMethod],
      });
      const { state } = createCronEditHarness(job, request, { cronJobs: [] });
      const mutation = toggleCronJob(state, job, false);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
      expect(request).toHaveBeenCalledWith(
        failedMethod,
        failedMethod === "cron.get" ? { id: job.id } : {},
      );
      const queued = loadCronStatus(state, { coalesce: true });
      failure.reject(new Error("Reconciliation unavailable"));
      expect(await mutation).toBe(true);
      await queued;
      expect(state.cronError).toBe("Reconciliation unavailable");
    },
  );
});
