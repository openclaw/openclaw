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
  createInitialCronState,
  toggleCronJob,
  loadCronStatus,
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
import { loadCronRuns, loadMoreCronRuns, updateCronRunsFilter } from "./runs.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    ...createInitialCronState({ connected: true }),
    ...overrides,
  };
}

function createCronRequest(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob({ id: jobId, name: "Existing job" });
  const jobs = options.existing ? [existingJob] : [];
  return createMethodRequest({
    "cron.add": { id: jobId },
    "cron.update": existingJob,
    "cron.list": cronJobsListResponse(jobs),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  });
}

function createMethodRequest(responses: Readonly<Record<string, unknown>>) {
  return vi.fn(async (method: string, _payload?: unknown) => responses[method] ?? {});
}

function createCronJob(overrides: Partial<CronJob> & Pick<CronJob, "id" | "name">): CronJob {
  return {
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

function findRequestCall(
  calls: ReadonlyArray<readonly [method: string, payload?: unknown]>,
  method: string,
): readonly [method: string, payload?: unknown] {
  const call = calls.find(([callMethod]) => callMethod === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return call;
}

function createStateWithRequest(request: unknown, overrides: Partial<CronState> = {}): CronState {
  return createState({
    client: { request } as unknown as CronState["client"],
    ...overrides,
  });
}

function createCronSubmitHarness(
  jobId: string,
  options: {
    method?: "cron.add" | "cron.update";
    form?: Partial<CronState["cronForm"]>;
  } = {},
) {
  const method = options.method ?? "cron.add";
  const request = createCronRequest(jobId, { existing: method === "cron.update" });
  const state = createStateWithRequest(request);
  if (method === "cron.update") {
    const job = createCronJob({ id: jobId, name: "Existing job" });
    state.cronJobs = [job];
    startCronEdit(state, job);
  }
  state.cronForm = { ...DEFAULT_CRON_FORM, ...options.form };
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: findRequestCall(request.mock.calls, method), result };
  };
  return { request, state, submit };
}

function createCronEditHarness(job: CronJob) {
  const request = createCronRequest(job.id, { existing: true });
  const state = createStateWithRequest(request, { cronJobs: [job] });
  startCronEdit(state, job);
  const submit = async () => {
    await addCronJob(state);
    return findRequestCall(request.mock.calls, "cron.update");
  };
  return { request, state, submit };
}

function revisionConflict() {
  return Object.assign(new Error("cron job definition changed"), {
    details: { code: "CRON_JOB_CHANGED" },
  });
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requestPayload(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(call[1], `${call[0]} payload`);
}

function requestPatch(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(requestPayload(call).patch, `${call[0]} patch`);
}

function cronJobsListResponse(
  jobs: CronJob[] = [],
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "cron-jobs-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

function createCronRunsResult(
  entries: CronRunsResult["entries"],
  overrides: Partial<Omit<CronRunsResult, "entries">> = {},
): CronRunsResult {
  return {
    entries,
    total: entries.length,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

function runEntry(jobId: string, ts: number) {
  return { ts, jobId, action: "finished", status: "ok" } as const;
}

function createCronRunsRace(currentEntries: CronRunsResult["entries"]) {
  const older = createDeferred<CronRunsResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => older.promise)
    .mockResolvedValueOnce(createCronRunsResult(currentEntries));
  return { older, state: createStateWithRequest(request) };
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
    const { call, result } = await createCronSubmitHarness("no-timeout", {
      method: "cron.update",
      form: { name: "No timeout", payloadText: "Run until complete", timeoutSeconds: "0" },
    }).submit();
    expect(result).toEqual({ saved: true, jobId: "no-timeout" });
    expect(requestPatch(call).payload).toEqual({
      kind: "agentTurn",
      message: "Run until complete",
      timeoutSeconds: 0,
    });
  });

  it("submits webhook delivery", async () => {
    const { call, result } = await createCronSubmitHarness("webhook", {
      form: {
        name: "Webhook",
        payloadText: "run",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    }).submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call)).toMatchObject({
      name: "Webhook",
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
  });

  it.each([{ job: { id: "wrapped" } }, { id: "bare" }])(
    "returns the saved id from %j",
    async (response) => {
      const request = createMethodRequest({
        "cron.add": response,
        "cron.list": cronJobsListResponse(),
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      });
      const state = createStateWithRequest(request, {
        cronForm: {
          ...DEFAULT_CRON_FORM,
          name: "ID echo",
          payloadText: "run",
          scheduleKind: "cron",
          cronExpr: "0 * * * *",
        },
      });
      expect(await addCronJob(state)).toEqual({
        saved: true,
        jobId: "job" in response ? "wrapped" : "bare",
      });
    },
  );

  it("clears stored payload overrides, including a zero timeout", async () => {
    const { state, submit } = createCronEditHarness(
      createCronJob({
        id: "clear-payload",
        name: "Clear overrides",
        payload: {
          kind: "agentTurn",
          message: "do work",
          model: "openai/gpt-5.5",
          thinking: "high",
          timeoutSeconds: 0,
        },
      }),
    );
    expect(state.cronForm.timeoutSeconds).toBe("0");
    Object.assign(state.cronForm, { payloadModel: "", payloadThinking: "", timeoutSeconds: "" });
    expect(requestPatch(await submit()).payload).toEqual({
      kind: "agentTurn",
      message: "do work",
      model: null,
      thinking: null,
      timeoutSeconds: null,
    });
  });

  it("clears unsupported announce delivery for main-session events", async () => {
    const { state, submit } = createCronSubmitHarness("main-event", {
      form: {
        name: "Main event",
        sessionTarget: "main",
        payloadKind: "systemEvent",
        payloadText: "run",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });
    expect(requestPayload((await submit()).call).delivery).toEqual({ mode: "none" });
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it("saves exact timing and explicit owner clearing in an event update", async () => {
    const { state, submit } = createCronEditHarness(createCronJob({ id: "job", name: "Event" }));
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
    const job = createCronJob({
      id: "job-missing-revision",
      name: "Missing revision",
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
    const stale = createCronJob({ id: "conflict", name: "Loaded", configRevision: "stale" });
    const current = {
      ...stale,
      name: "Current",
      description: "Latest definition",
      configRevision: "current",
    };
    const saved = { ...current, name: "Retried", configRevision: "saved" };
    const updates = vi.fn(async (_payload?: unknown) => saved);
    updates.mockRejectedValueOnce(revisionConflict());
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        return updates(payload);
      }
      if (method === "cron.list") {
        return cronJobsListResponse();
      }
      if (method === "cron.get") {
        return current;
      }
      return { enabled: true, jobs: 1 };
    });
    const state = createStateWithRequest(request, { cronJobs: [stale], cronJobsQuery: "filtered" });
    startCronEdit(state, stale);
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
    const stale = createCronJob({ id: "conflict", name: "Loaded", configRevision: "stale" });
    const current = { ...stale, name: "Current", configRevision: "current" };
    const firstList = createDeferred<CronJobsListResult>();
    const list = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockResolvedValue(cronJobsListResponse([current]));
    const revisions: unknown[] = [];
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        revisions.push(requireRecord(payload, "update").expectedConfigRevision);
        throw revisionConflict();
      }
      if (method === "cron.list") {
        return list();
      }
      if (method === "cron.get") {
        throw new Error("Exact refresh unavailable");
      }
      return { enabled: true, jobs: 1 };
    });
    const state = createStateWithRequest(request, { cronJobs: [stale] });
    startCronEdit(state, stale);
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

  it("commits authoritative update state before a failed jobs reconciliation", async () => {
    const loadedJob = createCronJob({
      id: "job-authoritative-save",
      name: "Loaded name",
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      name: "Saved name",
      updatedAtMs: 2,
      configRevision: "revision-saved",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "cron.update") {
        return updatedJob;
      }
      if (method === "cron.list") {
        throw new Error("reconciliation unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, { cronJobs: [loadedJob] });
    startCronEdit(state, loadedJob);
    state.cronForm.name = "Saved name";

    await expect(addCronJob(state)).resolves.toEqual({
      saved: true,
      jobId: loadedJob.id,
    });

    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
  });

  it("commits authoritative toggle state and advances an open editor revision", async () => {
    const loadedJob = createCronJob({
      id: "job-authoritative-toggle",
      name: "Toggle job",
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
    const state = createStateWithRequest(request, { cronJobs: [loadedJob] });
    startCronEdit(state, loadedJob);
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
    expect(updateCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedConfigRevision: "revision-toggled",
        patch: expect.objectContaining({ name: "Unsaved rename" }),
      }),
    );
  });

  it("removes confirmed jobs locally before a failed reconciliation", async () => {
    const removedJob = createCronJob({ id: "job-remove-local", name: "Remove locally" });
    const remainingJob = createCronJob({ id: "job-remaining", name: "Keep locally" });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      if (method === "cron.list") {
        throw new Error("reconciliation unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobs: [removedJob, remainingJob],
      cronJobsTotal: 2,
      cronRunsJobId: removedJob.id,
      cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
      cronRunsTotal: 1,
    });
    startCronEdit(state, removedJob);

    await removeCronJob(state, removedJob);

    expect(state.cronJobs).toEqual([remainingJob]);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([]);
  });

  it("clears persisted delivery routing when its inputs are blanked", async () => {
    const job = createCronJob({
      id: "clear-routing",
      name: "Routed job",
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

  it.each([undefined, null, "deliver", "unknown", " ANNOUNCE "])(
    "requires an explicit delivery choice before editing a persisted mode %s",
    async (mode) => {
      const job = createCronJob({
        id: "legacy-delivery",
        name: "Garden summary",
        delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
      });
      if (mode === undefined) {
        Reflect.deleteProperty(job.delivery!, "mode");
      } else {
        Reflect.set(job.delivery!, "mode", mode);
      }
      const original = structuredClone(job);
      const { request, state } = createCronEditHarness(job);
      state.cronForm.name = "Renamed garden summary";
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
      expect(job).toEqual(original);
      expect(state.cronFieldErrors.deliveryMode).toBe("cron.errors.deliveryModeRequired");

      state.cronForm.deliveryMode = "announce";
      expect(await addCronJob(state)).toMatchObject({ saved: true, jobId: job.id });
      const patch = requestPatch(findRequestCall(request.mock.calls, "cron.update"));
      expect(patch.name).toBe("Renamed garden summary");
      expect(patch.delivery).toMatchObject({
        mode: "announce",
        channel: "telegram",
        to: "garden-room",
      });
      expect(
        validateCronUpdateParams(
          requestPayload(findRequestCall(request.mock.calls, "cron.update")),
        ),
      ).toBe(true);
    },
  );

  it("loads declared Workshop jobs as locked rows", async () => {
    const job = createCronJob({
      id: "review",
      name: "Review",
      declarationKey: "skill-collection-review:main",
    });
    const request = createMethodRequest({ "cron.list": cronJobsListResponse([job]) });
    const state = createStateWithRequest(request);
    await loadCronJobsPage(state);
    expect(state.cronJobs).toEqual([job]);
    startCronEdit(state, job);
    expect(state.cronForm).toMatchObject({ payloadKind: "agentTurn", payloadLocked: true });
  });

  it("preserves configured duration precision when editing a staggered cron expression", async () => {
    const job = createCronJob({
      id: "job-exact-stagger",
      name: "Exact stagger",
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
    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
  });

  it("accepts prefixed-number stagger input", async () => {
    const { call, result } = await createCronSubmitHarness("stagger", {
      form: {
        name: "Stagger",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        staggerAmount: "0x10",
        staggerUnit: "seconds",
        payloadText: "run",
      },
    }).submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call).schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      staggerMs: 16_000,
    });
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
  });

  it("accepts the maximum representable interval", async () => {
    const { call, result } = await createCronSubmitHarness("maximum", {
      form: {
        name: "Maximum",
        payloadText: "run",
        everyAmount: "8640000000000",
        everyUnit: "seconds",
      },
    }).submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call).schedule).toEqual({
      kind: "every",
      everyMs: 8_640_000_000_000_000,
    });
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
  });

  it("applies schedule edits when changing an on-exit job to a regular schedule", async () => {
    const job = createCronJob({
      id: "job-on-exit",
      name: "On exit",
      schedule: { kind: "on-exit", command: "make build", cwd: "/repo" },
    });
    const { state, submit } = createCronEditHarness(job);

    state.cronForm.scheduleKind = "every";
    state.cronForm.everyAmount = "5";
    state.cronForm.everyUnit = "minutes";
    expect(requestPatch(await submit()).schedule).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it("preserves the trigger draft and inventory when its syntax is rejected", async () => {
    const job = createCronJob({
      id: "syntax",
      name: "Conditional job",
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
    const job = createCronJob({
      id: "job-script-trigger-conflict",
      name: "Conflicting script",
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

  it("clears persisted failure alert routing fields when their edit inputs are blanked", async () => {
    const job = createCronJob({
      id: "job-clear-alert-fields",
      name: "Clear failure alert fields",
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

    state.cronForm.failureAlertChannel = "last";
    state.cronForm.failureAlertDeliveryMode = "";
    state.cronForm.failureAlertAfter = "";
    state.cronForm.failureAlertTo = "";
    state.cronForm.failureAlertCooldownSeconds = "";
    state.cronForm.failureAlertAccountId = "";
    const call = await submit();

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify explicit clears on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({
      channel: "last",
      mode: null,
      includeSkipped: true,
      after: null,
      to: null,
      cooldownMs: null,
      accountId: null,
    });
  });

  it("clears an alert override when returning to inheritance", async () => {
    const { state, submit } = createCronEditHarness(
      createCronJob({
        id: "inherit",
        name: "Inherit",
        failureAlert: { after: 2, channel: "telegram" },
      }),
    );
    state.cronForm.failureAlertMode = "inherit";
    expect(requestPatch(await submit()).failureAlert).toBeNull();
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
    [{ everyAmount: "0.000001" }, "everyAmount", "cron.errors.everyAmountInvalid"],
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
    const { state, request } = createCronSubmitHarness("invalid", {
      form: { name: "Invalid duration", payloadText: "run", ...form },
    });
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors).toHaveProperty(field, error);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts the minimum conditional interval", async () => {
    const { call, result } = await createCronSubmitHarness("minimum", {
      form: {
        name: "Minimum",
        everyAmount: "30",
        everyUnit: "seconds",
        payloadText: "run",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
    }).submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call).schedule).toEqual({ kind: "every", everyMs: 30_000 });
  });

  it("cancels editing into a clean form for the selected owner", () => {
    const state = createState({ cronAgentId: null });
    startCronEdit(state, createCronJob({ id: "cancel", name: "Editable" }));
    state.cronForm.name = "changed";
    state.cronFieldErrors = { name: "Required" };
    cancelCronEdit(state, "writer");
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronForm).toEqual({ ...DEFAULT_CRON_FORM, agentId: "writer" });
    expect(state.cronFieldErrors).toEqual({});
  });

  it("submits cron.add after cloning", async () => {
    const request = createCronRequest("job-new");
    const sourceJob = createCronJob({
      id: "job-1",
      name: "Daily ping",
      agentId: "writer",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    });
    const state = createStateWithRequest(request, {
      cronJobs: [sourceJob],
      cronAgentId: "main",
    });

    startCronEdit(state, sourceJob);
    startCronClone(state, sourceJob);
    await addCronJob(state);

    const addCall = findRequestCall(request.mock.calls, "cron.add");
    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeUndefined();
    expect(addCall[1]).toEqual(
      expect.objectContaining({ name: "Daily ping copy", agentId: "writer" }),
    );
  });

  it.each([
    { name: "inherited", policy: {} },
    {
      name: "explicit false values",
      policy: {
        fallbacks: [],
        allowUnsafeExternalContent: false,
        lightContext: false,
      },
    },
    {
      name: "explicit true values",
      policy: {
        fallbacks: ["openai/gpt-5.5"],
        allowUnsafeExternalContent: true,
        lightContext: true,
      },
    },
  ] satisfies Array<{
    name: string;
    policy: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>>;
  }>)("clones $name payload policy", async ({ policy }) => {
    const source = createCronJob({
      id: "source",
      name: "Policy source",
      payload: { kind: "agentTurn", message: "Synthetic task", ...policy },
    });
    const original = structuredClone(source);
    const request = createCronRequest("clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    const expected: Extract<CronJob["payload"], { kind: "agentTurn" }> = {
      kind: "agentTurn",
      message: "Synthetic task",
      ...policy,
    };
    expect(submitted.payload).toEqual(expected);
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
  });

  it.each([
    {
      name: "edited",
      form: {
        payloadText: " Edited task ",
        payloadModel: " openai/gpt-5.5 ",
        payloadThinking: " low ",
        timeoutSeconds: "0.25",
        payloadLightContext: false,
      },
      expected: {
        message: "Edited task",
        model: "openai/gpt-5.5",
        thinking: "low",
        timeoutSeconds: 0.25,
        lightContext: false,
      },
    },
    {
      name: "cleared",
      form: { payloadModel: " ", payloadThinking: " ", timeoutSeconds: " " },
      expected: { message: "Synthetic task", lightContext: true },
    },
  ] satisfies Array<{
    name: string;
    form: Partial<CronState["cronForm"]>;
    expected: Record<string, unknown>;
  }>)("clones $name visible payload overrides", async ({ form, expected }) => {
    const source = createCronJob({
      id: "source",
      name: "Source",
      payload: {
        kind: "agentTurn",
        message: "Synthetic task",
        model: "openai/gpt-5.4",
        thinking: "high",
        timeoutSeconds: 45,
        lightContext: true,
      },
    });
    const original = structuredClone(source);
    const request = createCronRequest("clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    Object.assign(state.cronForm, form);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const payload = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(payload)).toBe(true);
    expect(source).toEqual(original);
    expect(payload.payload).toEqual({ kind: "agentTurn", ...expected });
  });

  it.each([
    {
      name: "system event to agent task",
      payload: { kind: "systemEvent", text: "Original event", toolsAllow: [] },
      trigger: { script: "return { fire: true }", once: true },
      target: "agentTurn",
    },
    {
      name: "agent task to system event",
      payload: {
        kind: "agentTurn",
        message: "Original task",
        toolsAllow: ["read"],
        fallbacks: [],
        allowUnsafeExternalContent: true,
        lightContext: false,
      },
      trigger: undefined,
      target: "systemEvent",
    },
    {
      name: "command to new agent task",
      payload: { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
      trigger: { script: "return { fire: true }", once: false },
      target: "agentTurn",
    },
  ] satisfies Array<{
    name: string;
    payload: CronJob["payload"];
    trigger: CronJob["trigger"];
    target: "agentTurn" | "systemEvent";
  }>)("clones $name with the operator-authored payload", async (scenario) => {
    const source = createCronJob({
      id: "kind-source",
      name: "Kind transition source",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: scenario.payload.kind === "systemEvent" ? "main" : "isolated",
      payload: scenario.payload,
      trigger: scenario.trigger,
    });
    const original = structuredClone(source);
    const request = createCronRequest("kind-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    if (scenario.payload.kind === "command") {
      expect(state.cronForm.payloadText).toBe("");
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
      expect(request).not.toHaveBeenCalled();
    }
    Object.assign(state.cronForm, {
      payloadKind: scenario.target,
      sessionTarget: scenario.target === "systemEvent" ? "main" : "isolated",
      payloadText: "New operator-authored task",
    });

    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "kind-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.trigger).toEqual(scenario.trigger);
    expect(submitted.payload).toEqual({
      kind: scenario.target,
      ...(scenario.target === "systemEvent"
        ? { text: "New operator-authored task" }
        : { message: "New operator-authored task" }),
    });
  });

  it("omits hidden payload policy from updates so the Gateway retains authority", async () => {
    const source = createCronJob({
      id: "policy-update",
      name: "Policy update",
      payload: {
        kind: "agentTurn",
        message: "Synthetic task",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true,
        fallbacks: [],
        allowUnsafeExternalContent: true,
        lightContext: false,
      },
    });
    const original = structuredClone(source);
    const { state, submit } = createCronEditHarness(source);
    state.cronForm.description = "Metadata changed";
    const call = await submit();
    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
    expect(source).toEqual(original);
    expect(requestPatch(call).payload).toEqual({
      kind: "agentTurn",
      message: "Synthetic task",
      lightContext: false,
    });
  });

  it.each([
    { name: "precise one-shot", schedule: { kind: "at", at: "2030-01-02T03:04:56.789Z" } },
    {
      name: "anchored interval",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_725_000_000_123 },
    },
    {
      name: "minute cron stagger",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 60_000 },
    },
    { name: "process exit", schedule: { kind: "on-exit", command: "make build", cwd: "/repo" } },
  ] as const)("clones the exact $name schedule while its fields remain unchanged", async (item) => {
    const request = createCronRequest("job-schedule-clone");
    const sourceJob = createCronJob({
      id: "job-schedule-source",
      name: "Source schedule",
      schedule: item.schedule,
    });
    const state = createStateWithRequest(request, { cronJobs: [sourceJob] });

    startCronClone(state, sourceJob);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "job-schedule-clone" });

    expect(requestPayload(findRequestCall(request.mock.calls, "cron.add")).schedule).toEqual(
      item.schedule,
    );
  });

  it("round-trips hidden delivery destinations through clone and edit", async () => {
    const sourceJob = createCronJob({
      id: "job-routing",
      name: "Routed job",
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
    const addPayload = requestPayload(findRequestCall(addRequest.mock.calls, "cron.add"));
    expect(addPayload.delivery).toEqual(sourceJob.delivery);
    expect(addPayload.sessionKey).toBe("agent:ops:main");
    expect(validateCronAddParams(addPayload)).toBe(true);

    const updateRequest = createCronRequest(sourceJob.id, { existing: true });
    const editState = createStateWithRequest(updateRequest, { cronJobs: [sourceJob] });
    startCronEdit(editState, sourceJob);
    editState.cronForm.deliveryThreadId = "thread-42";
    await addCronJob(editState);
    const updatePayload = requestPayload(findRequestCall(updateRequest.mock.calls, "cron.update"));
    expect(requireRecord(updatePayload.patch, "cron.update patch").delivery).toEqual({
      ...sourceJob.delivery,
      threadId: "thread-42",
    });
    expect(validateCronUpdateParams(updatePayload)).toBe(true);
  });

  it("loads a page with the selected agent, filters, and sorting", async () => {
    const job = createCronJob({ id: "daily", name: "Daily" });
    const request = createMethodRequest({ "cron.list": cronJobsListResponse([job]) });
    const state = createStateWithRequest(request, {
      cronAgentId: "writer",
      cronJobsQuery: "daily",
      cronJobsEnabledFilter: "enabled",
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
      cronJobsTriggerFilter: "conditional",
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "desc",
    });
    await loadCronJobsPage(state, { tableFilters: true });
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({
        agentId: "writer",
        limit: 50,
        offset: 0,
        query: "daily",
        enabled: "enabled",
        includeDeliveryPreviews: false,
        scheduleKind: "cron",
        lastRunStatus: "error",
        trigger: "conditional",
        sortBy: "updatedAtMs",
        sortDir: "desc",
      }),
    );
    expect(state).toMatchObject({ cronJobs: [job], cronJobsTotal: 1, cronJobsHasMore: false });
  });

  it("appends jobs only from the accepted snapshot revision", async () => {
    const firstJob = createCronJob({ id: "job-1", name: "First" });
    const secondJob = createCronJob({ id: "job-2", name: "Second" });
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
    const staleJob = createCronJob({ id: "stale-only", name: "Stale" });
    const stableJob = createCronJob({ id: "stable", name: "Stable" });
    const currentJob = createCronJob({ id: "current", name: "Current" });
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
    const job = createCronJob({ id: "existing", name: "Existing" });
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

  it.each([false, true])(
    "reloads changed filters after an in-flight page (append=%s)",
    async (append) => {
      const { first, payloads, request, state } = createCronJobsReloadHarness({
        cronJobsSnapshotRevision: "revision-a",
        cronJobsTotal: 2,
        cronJobsHasMore: true,
        cronJobsNextOffset: 1,
      });
      const pending = loadCronJobsPage(state, { append, tableFilters: true });
      updateCronJobsFilter(state, {
        cronJobsScheduleKindFilter: "cron",
        cronJobsLastStatusFilter: "unknown",
      });
      await loadCronJobsPage(state, { tableFilters: true });
      first.resolve(
        cronJobsListResponse(
          [],
          append ? { snapshotRevision: "revision-b", total: 1, offset: 1 } : {},
        ),
      );
      await pending;
      expect(payloads[0]).toMatchObject({ offset: append ? 1 : 0 });
      expect(payloads[1]).toMatchObject({
        offset: 0,
        scheduleKind: "cron",
        lastRunStatus: "unknown",
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(state).toMatchObject({
        cronJobsReloadPending: false,
        cronJobsReloadPendingTableFilters: false,
        cronJobsSnapshotRevision: "cron-jobs-fixture",
      });
    },
  );

  it("uses the latest queued cron jobs table-filter mode", async () => {
    const { first, payloads, request, state } = createCronJobsReloadHarness({
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "unknown",
    });

    const firstLoad = loadCronJobsPage(state);
    await loadCronJobsPage(state, { tableFilters: true });
    await loadCronJobsPage(state);
    first.resolve(cronJobsListResponse());
    await firstLoad;

    const pendingPayload = requireRecord(payloads[1], "latest pending cron.list payload");
    expect(pendingPayload).not.toHaveProperty("scheduleKind");
    expect(pendingPayload).not.toHaveProperty("lastRunStatus");
    expect(pendingPayload).not.toHaveProperty("trigger");
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cronJobsReloadPending).toBe(false);
    expect(state.cronJobsReloadPendingTableFilters).toBe(false);
  });

  it("drops malformed jobs without changing the server's inventory total", async () => {
    const job = createCronJob({ id: "good", name: "Good" });
    const request = createMethodRequest({
      "cron.list": {
        ...cronJobsListResponse([job], { total: 2 }),
        jobs: [{ id: "bad", name: "Missing payload", enabled: true }, job],
      },
    });
    const state = createStateWithRequest(request);
    await loadCronJobsPage(state);
    expect(state).toMatchObject({ cronJobs: [job], cronJobsTotal: 2, cronJobsHasMore: false });
  });

  it("loads and appends the selected agent's run history", async () => {
    const newest = {
      ts: 2,
      jobId: "job",
      action: "finished",
      status: "ok",
      summary: "newest",
    } as const;
    const older = { ...newest, ts: 1, summary: "older" };
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        createCronRunsResult([newest], { total: 2, hasMore: true, nextOffset: 1 }),
      )
      .mockResolvedValueOnce(createCronRunsResult([older], { total: 2 }));
    const state = createStateWithRequest(request, { cronAgentId: "writer" });
    await expect(loadCronRuns(state)).resolves.toBe("ok");
    expect(state.cronRuns).toEqual([newest]);
    expect(state.cronRunsHasMore).toBe(true);
    await loadMoreCronRuns(state);
    expect(request).toHaveBeenLastCalledWith(
      "cron.runs",
      expect.objectContaining({ agentId: "writer", offset: 1 }),
    );
    expect(state.cronRuns).toEqual([newest, older]);
  });

  it("keeps selected-job history when an older overview finishes last", async () => {
    const selected = runEntry("selected", 2);
    const { older, state } = createCronRunsRace([selected]);
    const pending = loadCronRuns(state);
    updateCronRunsFilter(state, { cronRunsScope: "job" });
    state.cronRunsJobId = "selected";
    await expect(loadCronRuns(state)).resolves.toBe("ok");
    older.resolve(createCronRunsResult([runEntry("other", 1)]));
    await expect(pending).resolves.toBe("skipped");
    expect(state).toMatchObject({ cronRunsJobId: "selected", cronRuns: [selected] });
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

  it("reports a current run-history failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("History unavailable"));
    const state = createStateWithRequest(request);
    await expect(loadCronRuns(state)).resolves.toBe("error");
    expect(state.cronRunsError).toBe("History unavailable");
  });

  it("ignores a stale run-history failure after the current request succeeds", async () => {
    const currentEntry = {
      ts: 2,
      jobId: "fresh-job",
      action: "finished" as const,
      status: "ok" as const,
      summary: "fresh",
    };
    const { older: olderFailure, state } = createCronRunsRace([currentEntry]);

    const olderLoad = loadCronRuns(state);
    await expect(loadCronRuns(state)).resolves.toBe("ok");
    olderFailure.reject(new Error("stale cron history unavailable"));

    await expect(olderLoad).resolves.toBe("skipped");
    expect(state.cronRuns).toEqual([currentEntry]);
    expect(state.cronRunsError).toBeNull();
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
    const state = createState();
    startCronEdit(
      state,
      createCronJob({ id: "interval", name: "Interval", schedule: { kind: "every", everyMs } }),
    );
    expect(state.cronForm.everyUnit).toBe(unit);
    expect(state.cronForm.everyAmount).toBe(amount);
    expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(everyMs);
  }
});

it("omits an unchanged minute but sends a genuinely changed minute", async () => {
  const originalAt = "2030-01-02T03:04:56.789Z";
  const original = createCronJob({
    id: "job-at-precision",
    name: "Precise one-shot",
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
  const year = originalMinute.getFullYear();
  const month = String(originalMinute.getMonth() + 1).padStart(2, "0");
  const day = String(originalMinute.getDate()).padStart(2, "0");
  const hour = String(originalMinute.getHours()).padStart(2, "0");
  const minute = String(originalMinute.getMinutes()).padStart(2, "0");
  changed.state.cronForm.scheduleAt = `${year}-${month}-${day}T${hour}:${minute}`;
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
    {
      name: "explicit",
      policy: {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/cron",
        accountId: "bot-a",
        includeSkipped: true,
      },
    },
    { name: "implicit destination", policy: { channel: "last", includeSkipped: false } },
    { name: "disabled", policy: false },
  ] satisfies Array<{ name: string; policy: CronJob["failureAlert"] }>)(
    "clones the $name failure policy",
    async ({ policy }) => {
      const job = createCronJob({ id: "policy", name: "Policy", failureAlert: policy });
      const request = createCronRequest("clone");
      const state = createStateWithRequest(request);
      startCronClone(state, job);
      await addCronJob(state);
      const payload = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
      expect(validateCronAddParams(payload)).toBe(true);
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify omitted fields on the wire
      expect(JSON.parse(JSON.stringify(payload.failureAlert))).toEqual(policy);
    },
  );

  it.each([
    { cooldownMs: 0, seconds: "0" },
    { cooldownMs: Number.MAX_SAFE_INTEGER, seconds: "9007199254740.991" },
  ])(
    "preserves a $cooldownMs ms cooldown when editing metadata",
    async ({ cooldownMs, seconds }) => {
      const job = createCronJob({
        id: "cooldown-metadata",
        name: "Stored cooldown",
        failureAlert: {
          after: 4,
          cooldownMs,
          mode: "webhook",
          to: "https://alerts.example.test/cron",
        },
      });
      const { state, submit } = createCronEditHarness(job);

      expect(state.cronForm.failureAlertCooldownSeconds).toBe(seconds);
      state.cronForm.description = "Only the description changed";
      const call = await submit();

      expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
      expect(requestPatch(call).failureAlert).toMatchObject({
        cooldownMs,
      });
    },
  );

  it.each([
    ["1e-3", 1],
    ["0x10", 16_000],
  ] as const)("serializes cooldown seconds %s", async (seconds, cooldownMs) => {
    const { call } = await createCronSubmitHarness("cooldown", {
      form: {
        name: "Cooldown",
        payloadText: "run",
        failureAlertMode: "custom",
        failureAlertCooldownSeconds: seconds,
      },
    }).submit();
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    expect(requestPayload(call).failureAlert).toMatchObject({ cooldownMs });
  });

  it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
    const job = createCronJob({
      id: "command-inherited-policy",
      name: "Command alert policy",
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
      const job = createCronJob({ id: "selected", name: "Saved", state: { triggerEvalCount: 1 } });
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
      const job = createCronJob({ id: "selected", name: "Saved", state: {} });
      const pending = createDeferred<unknown>();
      const operationResponse = createDeferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === readMethod) {
          return pending.promise;
        }
        if (method === "cron.get") {
          return job;
        }
        if (method === "cron.update" || method === "cron.run") {
          return operationResponse.promise;
        }
        if (method === "cron.runs") {
          return { entries: [], total: 0, offset: 0, hasMore: false };
        }
        return { enabled: true, jobs: 1 };
      });
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
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
    const job = createCronJob({ id: "selected", name: "Saved", state: { triggerEvalCount: 1 } });
    const runResponse = createDeferred<unknown>();
    const firstJob = createDeferred<CronJob>();
    const lastJob = createDeferred<CronJob>();
    const firstStatus = createDeferred<unknown>();
    let jobReads = 0;
    let statusReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "cron.run") {
        return runResponse.promise;
      }
      if (method === "cron.get") {
        jobReads += 1;
        return jobReads === 1 ? firstJob.promise : lastJob.promise;
      }
      if (method === "cron.status") {
        statusReads += 1;
        return statusReads === 1 ? firstStatus.promise : { enabled: true, jobs: 9 };
      }
      return { entries: [], total: 0, offset: 0, hasMore: false };
    });
    const state = createStateWithRequest(request);
    startCronEdit(state, job);
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

  it.each([
    { failedMethod: "cron.get", queueEvent: true },
    { failedMethod: "cron.status", queueEvent: true },
  ] as const)(
    "keeps explicit reconciliation errors visible for $failedMethod with queueEvent=$queueEvent",
    async ({ failedMethod, queueEvent }) => {
      const job = createCronJob({ id: "selected", name: "Saved", state: {} });
      const failure = createDeferred<unknown>();
      let failedMethodReads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === failedMethod) {
          failedMethodReads += 1;
          return failedMethodReads === 1
            ? failure.promise
            : failedMethod === "cron.get"
              ? job
              : { enabled: true, jobs: 1 };
        }
        if (method === "cron.update" || method === "cron.get") {
          return job;
        }
        if (method === "cron.list") {
          return cronJobsListResponse([job]);
        }
        return { enabled: true, jobs: 1 };
      });
      const state = createStateWithRequest(request);
      startCronEdit(state, job);
      const mutation = toggleCronJob(state, job, false);
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
      expect(request).toHaveBeenCalledWith(
        failedMethod,
        failedMethod === "cron.get" ? { id: job.id } : {},
      );
      const queued = queueEvent ? loadCronStatus(state, { coalesce: true }) : Promise.resolve();
      failure.reject(new Error("Reconciliation unavailable"));
      expect(await mutation).toBe(true);
      await queued;
      expect(state.cronError).toBe("Reconciliation unavailable");
    },
  );
});
