import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import {
  addCronJob,
  cancelCronEdit,
  loadCronJobsPage,
  loadCronRuns,
  loadMoreCronRuns,
  normalizeCronFormState,
  startCronEdit,
  startCronClone,
  validateCronForm,
  type CronState,
} from "./cron.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    client: null,
    connected: true,
    cronLoading: false,
    cronJobsLoadingMore: false,
    cronJobs: [],
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronStatus: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronFieldErrors: {},
    cronEditingJobId: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
    ...overrides,
  };
}

describe("cron controller", () => {
  it("normalizes stale announce mode when session/payload no longer support announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "main",
      payloadKind: "systemEvent",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("none");
  });

  it("keeps announce mode when isolated agentTurn supports announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("announce");
  });

  it("forwards webhook delivery in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "webhook job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "webhook job",
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
  });

  it("does not submit stale announce delivery when unsupported", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "main job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payloadKind: "systemEvent",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "main job",
    });
    expect((addCall?.[1] as { delivery?: unknown } | undefined)?.delivery).toBeUndefined();
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it("submits cron.update when editing an existing job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-1" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-1",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "edited job",
        description: "",
        clearAgent: true,
        deleteAfterRun: false,
        scheduleKind: "cron",
        cronExpr: "0 8 * * *",
        scheduleExact: true,
        payloadKind: "systemEvent",
        payloadText: "updated",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-1",
      patch: {
        name: "edited job",
        description: "",
        agentId: null,
        deleteAfterRun: false,
        schedule: { kind: "cron", expr: "0 8 * * *", staggerMs: 0 },
        payload: { kind: "systemEvent", text: "updated" },
      },
    });
    expect(state.cronEditingJobId).toBeNull();
  });

  it("maps a cron job into editable form fields", () => {
    const state = createState();
    const job = {
      id: "job-9",
      name: "Weekly report",
      description: "desc",
      enabled: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 7_200_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "ship it", timeoutSeconds: 45 },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123" },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronEditingJobId).toBe("job-9");
    expect(state.cronRunsJobId).toBe("job-9");
    expect(state.cronForm.name).toBe("Weekly report");
    expect(state.cronForm.enabled).toBe(false);
    expect(state.cronForm.scheduleKind).toBe("every");
    expect(state.cronForm.everyAmount).toBe("2");
    expect(state.cronForm.everyUnit).toBe("hours");
    expect(state.cronForm.payloadKind).toBe("agentTurn");
    expect(state.cronForm.payloadText).toBe("ship it");
    expect(state.cronForm.timeoutSeconds).toBe("45");
    expect(state.cronForm.deliveryMode).toBe("announce");
    expect(state.cronForm.deliveryChannel).toBe("telegram");
    expect(state.cronForm.deliveryTo).toBe("123");
  });

  it("includes model/thinking/stagger/bestEffort in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-2" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-2",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "advanced edit",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        staggerAmount: "30",
        staggerUnit: "seconds",
        payloadKind: "agentTurn",
        payloadText: "run it",
        payloadModel: "opus",
        payloadThinking: "low",
        deliveryMode: "announce",
        deliveryBestEffort: true,
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-2",
      patch: {
        schedule: { kind: "cron", expr: "0 9 * * *", staggerMs: 30_000 },
        payload: {
          kind: "agentTurn",
          message: "run it",
          model: "opus",
          thinking: "low",
        },
        delivery: { mode: "announce", bestEffort: true },
      },
    });
  });

  it("includes custom failureAlert fields in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "120",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-alert",
      patch: {
        failureAlert: {
          after: 3,
          cooldownMs: 120_000,
          channel: "telegram",
          to: "123456",
        },
      },
    });
  });

  it("omits failureAlert.cooldownMs when custom cooldown is left blank", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-no-cooldown" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-no-cooldown" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-no-cooldown",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job no cooldown",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-alert-no-cooldown",
      patch: {
        failureAlert: {
          after: 3,
          channel: "telegram",
          to: "123456",
        },
      },
    });
    expect(
      (updateCall?.[1] as { patch?: { failureAlert?: { cooldownMs?: number } } })?.patch
        ?.failureAlert,
    ).not.toHaveProperty("cooldownMs");
  });

  it("includes failureAlert=false when disabled per job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-no-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-no-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-no-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert off",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "disabled",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-no-alert",
      patch: { failureAlert: false },
    });
  });

  it("maps cron stagger, model, thinking, and best effort into form", () => {
    const state = createState();
    const job = {
      id: "job-10",
      name: "Advanced job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "UTC", staggerMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: {
        kind: "agentTurn" as const,
        message: "hi",
        model: "opus",
        thinking: "high",
      },
      delivery: { mode: "announce" as const, bestEffort: true },
      state: {},
    };
    startCronEdit(state, job);

    expect(state.cronForm.deleteAfterRun).toBe(true);
    expect(state.cronForm.scheduleKind).toBe("cron");
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("1");
    expect(state.cronForm.staggerUnit).toBe("minutes");
    expect(state.cronForm.payloadModel).toBe("opus");
    expect(state.cronForm.payloadThinking).toBe("high");
    expect(state.cronForm.deliveryBestEffort).toBe(true);
  });

  it("maps failureAlert overrides into form fields", () => {
    const state = createState();
    const job = {
      id: "job-11",
      name: "Failure alerts",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "hello" },
      failureAlert: {
        after: 4,
        cooldownMs: 30_000,
        channel: "telegram",
        to: "999",
      },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronForm.failureAlertMode).toBe("custom");
    expect(state.cronForm.failureAlertAfter).toBe("4");
    expect(state.cronForm.failureAlertCooldownSeconds).toBe("30");
    expect(state.cronForm.failureAlertChannel).toBe("telegram");
    expect(state.cronForm.failureAlertTo).toBe("999");
  });

  it("validates key cron form errors", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "",
      scheduleKind: "cron",
      cronExpr: "",
      payloadKind: "agentTurn",
      payloadText: "",
      timeoutSeconds: "0",
      deliveryMode: "webhook",
      deliveryTo: "ftp://bad",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });

  it("blocks add/update submit when validation errors exist", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "",
        payloadText: "",
      },
    });
    await addCronJob(state);
    expect(request).not.toHaveBeenCalled();
    expect(state.cronFieldErrors.name).toBeDefined();
    expect(state.cronFieldErrors.payloadText).toBeDefined();
  });

  it("canceling edit resets form to defaults and clears edit mode", () => {
    const state = createState();
    const job = {
      id: "job-cancel",
      name: "Editable",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 6 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, to: "123" },
      state: {},
    };
    startCronEdit(state, job);
    state.cronForm.name = "changed";
    state.cronFieldErrors = { name: "Name is required." };

    cancelCronEdit(state);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronForm).toEqual({ ...DEFAULT_CRON_FORM });
    expect(state.cronFieldErrors).toEqual(validateCronForm(DEFAULT_CRON_FORM));
  });

  it("cloning a job switches to create mode and applies copy naming", () => {
    const state = createState({
      cronJobs: [
        {
          id: "job-1",
          name: "Daily ping",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
          state: {},
        },
      ],
      cronEditingJobId: "job-1",
    });

    const sourceJob = state.cronJobs[0];
    expect(sourceJob).toBeDefined();
    if (!sourceJob) {
      return;
    }
    startCronClone(state, sourceJob);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronRunsJobId).toBe("job-1");
    expect(state.cronForm.name).toBe("Daily ping copy");
    expect(state.cronForm.payloadText).toBe("ping");
  });

  it("submits cron.add after cloning", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-new" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const sourceJob = {
      id: "job-1",
      name: "Daily ping",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "systemEvent" as const, text: "ping" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [sourceJob],
      cronEditingJobId: "job-1",
    });

    startCronClone(state, sourceJob);
    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(addCall).toBeDefined();
    expect(updateCall).toBeUndefined();
    expect((addCall?.[1] as { name?: string } | undefined)?.name).toBe("Daily ping copy");
  });

  it("loads paged jobs with query/filter/sort params", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        expect(payload).toMatchObject({
          limit: 50,
          offset: 0,
          query: "daily",
          enabled: "enabled",
          sortBy: "updatedAtMs",
          sortDir: "desc",
        });
        return {
          jobs: [{ id: "job-1", name: "Daily", enabled: true }],
          total: 1,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobsQuery: "daily",
      cronJobsEnabledFilter: "enabled",
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "desc",
    });

    await loadCronJobsPage(state);

    expect(state.cronJobs).toHaveLength(1);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("loads and appends paged run history", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.runs") {
        return {};
      }
      const offset = (payload as { offset?: number } | undefined)?.offset ?? 0;
      if (offset === 0) {
        return {
          entries: [{ ts: 2, jobId: "job-1", status: "ok", summary: "newest" }],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        };
      }
      return {
        entries: [{ ts: 1, jobId: "job-1", status: "ok", summary: "older" }],
        total: 2,
        hasMore: false,
        nextOffset: null,
      };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    await loadCronRuns(state, "job-1");
    expect(state.cronRuns).toHaveLength(1);
    expect(state.cronRunsHasMore).toBe(true);

    await loadMoreCronRuns(state);
    expect(state.cronRuns).toHaveLength(2);
    expect(state.cronRuns[0]?.summary).toBe("newest");
    expect(state.cronRuns[1]?.summary).toBe("older");
  });
});
