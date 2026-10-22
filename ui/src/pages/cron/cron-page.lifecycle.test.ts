import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, CronJob, CronJobsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  callsFor,
  text,
  fillInput,
  click,
  testId,
  expectCalls,
  waitForElement,
  inputValue,
} from "./cron-assertions.test-support.ts";
import {
  type CronTestPage,
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage, emitEvent } from "./cron-rpc.test-support.ts";
import { createCronViewJob, createCronViewRun, cronRunsResponse } from "./view.test-support.ts";
import "./cron-page.tsx";

function modelClient(read: (params?: unknown) => unknown) {
  return createTestGatewayClient(cronRpc({ "models.list": read }));
}

function expectModels(page: CronTestPage, models: string[]) {
  return waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(models));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([{ restartPending: true }, { suspensionPhase: "draining" as const }])(
  "pauses background reads during %j and catches up without replacing the draft",
  async (unavailable) => {
    vi.useFakeTimers();
    const request = createRequest();
    const gateway = createGateway(createTestGatewayClient(request), true);
    gateway.emitSnapshot(unavailable);
    const context = createContext(gateway);
    const page = createPage(context);
    await page.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    gateway.emitSnapshot({ restartPending: false, suspensionPhase: "accepting" });
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, refreshMethods, 1);
    const current = page.cron;
    current.cronCreateOpen = true;
    current.cronForm.name = "Unsaved automation";
    page.context = { ...context };
    page.refreshView();
    await page.settle();
    expect(page.cron).toBe(current);
    expect(current.cronForm.name).toBe("Unsaved automation");
    request.mockClear();
    gateway.emitSnapshot(unavailable);
    emitEvent(gateway, "cron");
    emitEvent(gateway, "config.changed");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(request).not.toHaveBeenCalled();
    gateway.emitSnapshot({ restartPending: false, suspensionPhase: "accepting" });
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, [...refreshMethods, "models.list"], 1);
    expect(page.cron).toBe(current);
    expect(current).toMatchObject({
      cronCreateOpen: true,
      cronForm: { name: "Unsaved automation" },
    });
  },
);

it.each(["catalog-needed", "configured-alternative"])(
  "preserves catalog provider identity through model selection and save (%s)",
  async (source) => {
    const configuredAlternatives = source === "configured-alternative";
    const models = [
      { provider: "alpha", id: "shared-model", name: "Alpha shared" },
      { provider: "beta", id: "shared-model", name: "Beta shared" },
      ...(configuredAlternatives
        ? [{ provider: "beta", id: "beta/shared-model", name: "Qualified beta shared" }]
        : []),
      {
        provider: "beta",
        id: "hidden-model",
        name: "Hidden model",
        manualSelectionAllowed: false,
      },
    ];
    const request = cronRpc({
      "models.list": () => ({ models }),
      "cron.add": () => ({ id: "identity-job" }),
      "cron.list": () => cronListResponse([]),
    });
    const gateway = createGateway(createTestGatewayClient(request), true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const context = createContext(gateway);
    Object.assign(context.runtimeConfig.state, {
      configForm: {
        agents: {
          defaults: {
            model: { primary: "alpha/shared-model" },
            modelPolicy: { allow: ["alpha/shared-model", "beta/shared-model"] },
            ...(configuredAlternatives
              ? { models: { "alpha/shared-model": {}, "beta/shared-model": {} } }
              : {}),
          },
        },
        models: {
          providers: Object.fromEntries(
            ["alpha", "beta"].map((provider) => [
              provider,
              {
                baseUrl: `https://${provider}.invalid`,
                models: [{ id: "shared-model", name: `${provider} shared` }],
              },
            ]),
          ),
        },
      },
    });
    const page = createPage(context, { render: true });
    await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
    await page.settle();
    click(page, testId("cron-new-task"));
    await waitForElement(page, "fieldset.cron-editor");
    fillInput(page, "#cron-name", "Provider identity");
    fillInput(page, "#cron-payload-text", "Use the selected model");
    await waitForCronPage(() => expect(page.cronModelSuggestions.length).toBeGreaterThan(0));
    await page.settle();
    const trigger = page.querySelector<HTMLButtonElement>("#cron-payload-model-picker")!;
    const picker = trigger.closest("openclaw-select-picker")!;
    trigger.click();
    await waitForCronPage(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(
        Array.from(picker.querySelectorAll<HTMLElement>('[role="option"]')).map(
          (option) => option.dataset.value,
        ),
      ).toEqual(["", "alpha/shared-model", "beta/shared-model", "__openclaw_custom_model__"]);
      const inheritText = text(picker, '[role="option"][data-value=""]') ?? "";
      expect(inheritText).toContain("Default");
      expect(inheritText).not.toContain("common.default");
    });
    picker.querySelector<HTMLElement>('[role="option"][data-value="beta/shared-model"]')!.click();
    await page.settle();
    const save = page.querySelector<HTMLButtonElement>(testId("cron-submit"))!;
    expect(save.disabled).toBe(false);
    save.click();
    await waitForCronPage(() => {
      const adds = callsFor(request, "cron.add");
      expect(adds).toHaveLength(1);
      expect(adds[0]?.[1]).toHaveProperty("payload", {
        kind: "agentTurn",
        message: "Use the selected model",
        model: "beta/shared-model",
      });
    });
    await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
  },
);

it.each([false, true])(
  "shows an internal catalog failure and empty recovery (retained rows: %s)",
  async (hasRows) => {
    let result = {
      models: [{ provider: "fixture", id: "obsolete", name: "Obsolete model" }],
      refreshFailed: false,
    };
    const { page, gateway } = mountCronPage(modelClient(() => result));
    await expectModels(page, ["fixture/obsolete"]);
    result = {
      models: hasRows ? [{ provider: "fixture", id: "current", name: "Current model" }] : [],
      refreshFailed: true,
    };
    emitEvent(gateway, "chat.metadata.changed");
    await expectModels(page, hasRows ? ["fixture/current"] : []);
    expect(page.textContent).toContain(
      hasRows
        ? "Some models could not be refreshed. Open Models to try again."
        : "Models unavailable",
    );
    result = { models: [], refreshFailed: false };
    emitEvent(gateway, "chat.metadata.changed");
    await waitForCronPage(() =>
      expect(page.textContent).not.toContain(
        hasRows ? "Some models could not be refreshed" : "Models unavailable",
      ),
    );
    await expectModels(page, []);
  },
);

it.each(["agent", "connection", "detach"])(
  "rejects a pending catalog error after %s changes",
  async (change) => {
    const oldError = createDeferred();
    let reads = 0;
    const client = modelClient(() => {
      reads += 1;
      if (reads === 1) {
        return { models: [{ id: "initial-model" }] };
      }
      if (reads === 2) {
        return oldError.promise;
      }
      return { models: [{ id: "current-model" }] };
    });
    const { page, gateway, context } = mountCronPage(client);
    await expectModels(page, ["initial-model"]);
    emitEvent(gateway, "config.changed");
    await waitForCronPage(() => expect(reads).toBe(2));
    expect(page.cronModelSuggestions).toEqual(["initial-model"]);
    if (change === "agent") {
      context.agentSelection.set("writer");
    } else if (change === "connection") {
      gateway.emitSnapshot({ phase: "reconnecting" });
      gateway.emitSnapshot({ phase: "connected" });
    } else {
      page.remove();
    }
    const readsBeforeCompletion = reads;
    oldError.reject(new Error("Retired catalog error"));
    await Promise.allSettled([oldError.promise]);
    if (change === "detach") {
      await page.settle();
      expect(page.isConnected).toBe(false);
      expect(page.childElementCount).toBe(0);
      expect(reads).toBe(readsBeforeCompletion);
    } else {
      await expectModels(page, ["current-model"]);
      await page.settle();
      expect(page.cronModelSuggestions).toEqual(["current-model"]);
    }
    expect(page.textContent).not.toContain("Retired catalog error");
  },
);

it("refreshes model suggestions when team selection changes without changing scope", async () => {
  const lateMain = createDeferred<{ models: { id: string }[] }>();
  const writer = createDeferred<{ models: { id: string }[] }>();
  const modelRequests: unknown[] = [];
  let mainReads = 0;
  const client = modelClient((params) => {
    modelRequests.push(params);
    const agentId = (params as { agentId?: string } | undefined)?.agentId;
    if (agentId === "writer") {
      return writer.promise;
    }
    mainReads += 1;
    return mainReads === 1 ? { models: [{ id: "main-model" }] } : lateMain.promise;
  });
  const gateway = createGateway(client, true);
  gateway.emitSnapshot({ assistantAgentId: "main" });
  const agentSelection = createAgentSelectionCapability(
    gateway,
    {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "writer" }],
        },
      },
      subscribe: () => () => undefined,
    },
    undefined,
    {
      settings: { gatewayUrl: "", sidebarAgentsMode: "roster", sidebarPreTeamScope: undefined },
      patch: () => undefined,
      subscribe: () => () => undefined,
    },
  );
  const page = createPage(
    { ...createContext(gateway, null, "main"), agentSelection },
    { render: true },
  );
  try {
    await expectModels(page, ["main-model"]);
    const cron = page.cron;
    emitEvent(gateway, "chat.metadata.changed");
    await waitForCronPage(() => expect(modelRequests).toHaveLength(2));
    agentSelection.set("writer");
    expect(agentSelection.state).toEqual({ selectedId: "writer", scopeId: null });
    await waitForCronPage(() => expect(modelRequests).toHaveLength(3));
    expect(page.cron).toBe(cron);
    expect(page.cronModelSuggestions).toEqual([]);
    expect(modelRequests).toEqual([
      { agentId: "main", view: "configured" },
      { agentId: "main", view: "configured" },
      { agentId: "writer", view: "configured" },
    ]);
    writer.resolve({ models: [{ id: "writer-model" }] });
    await expectModels(page, ["writer-model"]);
    lateMain.resolve({ models: [{ id: "late-main-model" }] });
    await lateMain.promise;
    await page.settle();
    expect(page.cronModelSuggestions).toEqual(["writer-model"]);
  } finally {
    page.remove();
    agentSelection.dispose();
    writer.resolve({ models: [] });
    lateMain.resolve({ models: [] });
  }
});

it("applies run events to the complete job table without fetching the inventory again", async () => {
  const job = createCronViewJob("running-job", { state: { nextRunAtMs: 100 } });
  const other = createCronViewJob("other-job", { state: { nextRunAtMs: 200 } });
  const request = cronRpc({ "cron.list": () => cronListResponse(structuredClone([job, other])) });
  const { page, gateway } = mountCronPage(request);
  await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(2));
  await page.settle();
  request.mockClear();
  emitEvent(gateway, "cron", {
    action: "started",
    jobId: job.id,
    job: {
      id: job.id,
      name: job.name,
      enabled: true,
      updatedAtMs: 1,
      state: { nextRunAtMs: 100, runningAtMs: 100 },
    },
  });
  await page.settle();
  expect(page.cron.cronJobs[0]?.state.runningAtMs).toBe(100);
  expect(callsFor(request, "cron.list"), "started event").toHaveLength(0);
  emitEvent(gateway, "cron", {
    action: "finished",
    jobId: job.id,
    status: "ok",
    durationMs: 10,
    job: {
      id: job.id,
      name: job.name,
      enabled: true,
      updatedAtMs: 2,
      state: { nextRunAtMs: 300, lastRunAtMs: 100, lastRunStatus: "ok" },
    },
  });
  await page.settle();
  expect(page.cron.cronJobs.map((entry) => entry.id)).toEqual([other.id, job.id]);
  expect(page.cron.cronJobs[1]?.state).toMatchObject({ lastRunStatus: "ok", lastDurationMs: 10 });
  expect(page.cron.cronJobs[1]?.state.runningAtMs).toBeUndefined();
  expect(callsFor(request, "cron.list")).toHaveLength(0);
});

it("keeps the periodic inventory recovery visible-only", async () => {
  vi.useFakeTimers();
  const visibility = controlVisibility();
  const request = createRequest();
  const { page } = mountCronPage(request, { render: false });
  await vi.advanceTimersByTimeAsync(0);
  request.mockClear();
  visibility("hidden");
  await vi.advanceTimersByTimeAsync(600_000);
  expect(request).not.toHaveBeenCalled();
  visibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  request.mockClear();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(callsFor(request, "cron.list")).toHaveLength(1);
  page.remove();
});

it("coalesces a cron event burst into one trailing refresh of the current page", async () => {
  const held = createDeferred();
  let released = false;
  const freshJob = createCronViewJob("fresh-job", { configRevision: "fresh-config", state: {} });
  const freshRun = createCronViewRun({
    ts: 2,
    jobId: freshJob.id,
    summary: "Finished after the refresh started",
  });
  const request = vi.fn(async (method: string) => {
    const stale = !released;
    if (method.startsWith("cron.") || method === "channels.status") {
      await held.promise;
    }
    if (method === "cron.status") {
      return { enabled: true, triggersEnabled: true, jobs: stale ? 0 : 1 };
    }
    if (method === "cron.list") {
      return cronListResponse(stale ? [] : [freshJob]);
    }
    if (method === "cron.runs") {
      return { entries: stale ? [] : [freshRun], total: stale ? 0 : 1, hasMore: false };
    }
    if (method === "channels.status") {
      return { channelOrder: [], channels: {}, channelAccounts: {} };
    }
    return { models: [] };
  });
  const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
  const channels = createChannelCapability(gateway);
  const context = { ...createContext(gateway), channels };
  const page = createPage(context);
  try {
    await page.settle();
    emitEvent(gateway, "cron", {}, 20);
    expectCalls(request, ["cron.status", "cron.runs", "cron.list", "channels.status"], 1);
    released = true;
    held.resolve();
    await waitForCronPage(() => {
      expect(page.cron.cronStatus?.jobs).toBe(1);
      expect(page.cron.cronJobs).toEqual([freshJob]);
      expect(page.cron.cronRuns).toEqual([freshRun]);
    });
    expectCalls(request, ["cron.status", "cron.runs", "cron.list"], 2);
    expect(callsFor(request, "channels.status")).toHaveLength(1);
  } finally {
    page.remove();
    channels.dispose();
    released = true;
    held.resolve();
  }
});

it("lets manual Refresh supersede held status and run-history reads", async () => {
  const held = createDeferred();
  const calls = { "cron.status": 0, "cron.runs": 0 };
  const fallback = createRequest();
  const request = vi.fn(async (method: string) => {
    if (method !== "cron.status" && method !== "cron.runs") {
      return fallback(method);
    }
    const revision = ++calls[method];
    if (revision === 1) {
      await held.promise;
    }
    return method === "cron.status"
      ? { enabled: true, triggersEnabled: true, jobs: revision }
      : cronRunsResponse([createCronViewRun({ ts: revision, jobId: "job" })]);
  });
  const { page } = mountCronPage(request);
  try {
    await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
    await page.settle();
    expect(calls).toEqual({ "cron.status": 1, "cron.runs": 1 });
    const refresh = page.querySelector<HTMLButtonElement>(".cron-refresh");
    expect(refresh).not.toBeNull();
    refresh?.click();
    expect(calls).toEqual({ "cron.status": 2, "cron.runs": 2 });
    await waitForCronPage(() => {
      expect(page.cron.cronStatus?.jobs).toBe(2);
      expect(page.cron.cronRuns[0]?.ts).toBe(2);
    });
    held.resolve();
    await settle();
    expect(page.cron.cronStatus?.jobs).toBe(2);
    expect(page.cron.cronRuns[0]?.ts).toBe(2);
    expect(calls).toEqual({ "cron.status": 2, "cron.runs": 2 });
  } finally {
    page.remove();
    held.resolve();
  }
});

it.each(["disconnect", "reconnect", "agent scope", "gateway source", "unmount"])(
  "retires queued cron event refreshes on %s",
  async (change) => {
    const held = createDeferred();
    let hold = true;
    const fallback = createRequest();
    const request = vi.fn(async (method: string) => {
      if (hold && method.startsWith("cron.")) {
        await held.promise;
        if (method === "cron.status") {
          return { enabled: true, triggersEnabled: true, jobs: 99 };
        }
        if (method === "cron.list") {
          return cronListResponse([createCronViewJob("retired-job")]);
        }
        if (method === "cron.runs") {
          return cronRunsResponse([createCronViewRun({ ts: 99, jobId: "retired-job" })]);
        }
      }
      return fallback(method);
    });
    const { page, client, gateway, context } = mountCronPage(request, { render: false });
    try {
      await page.settle();
      emitEvent(gateway);
      hold = false;
      if (change === "disconnect" || change === "reconnect") {
        gateway.emitSnapshot({ phase: "stopped" });
        if (change === "reconnect") {
          gateway.emitSnapshot({ phase: "connected" });
        }
      } else if (change === "agent scope") {
        context.agentSelection.setScope("writer");
      } else if (change === "gateway source") {
        page.context = createContext(createGateway(client, true));
        page.refreshView();
      } else {
        page.remove();
      }
      await page.settle();
      await waitForCronPage(() =>
        expect(callsFor(request, "models.list")).toHaveLength(
          // Reconnection retires the client; another owner of the same client can share its read.
          change === "reconnect" ? 2 : 1,
        ),
      );
      const count = request.mock.calls.length;
      held.resolve();
      await settle();
      await page.settle();
      expect(request).toHaveBeenCalledTimes(count);
      if (change === "unmount") {
        expect(page.isConnected).toBe(false);
        expect(page.childElementCount).toBe(0);
      } else {
        expect(page.cron.cronError).toBeNull();
        expect(page.cron.cronStatus?.jobs).not.toBe(99);
        expect(page.cron.cronJobs.some((job) => job.id === "retired-job")).toBe(false);
        expect(page.cron.cronRuns.some((run) => run.jobId === "retired-job")).toBe(false);
      }
    } finally {
      page.remove();
      held.resolve();
    }
  },
);

it("refreshes trigger authoring from scheduler status after reconnect", async () => {
  const schedulerStatus = { enabled: true, jobs: 0, triggersEnabled: true };
  const request = createRequest(schedulerStatus);
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client, true);
  const context = createContext(gateway);
  Object.assign(context.runtimeConfig.state, {
    configForm: { cron: { triggers: { enabled: true } } },
    configNeedsApply: true,
  });
  const page = createPage(context, { render: true });
  await waitForCronPage(() =>
    expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: true }),
  );
  schedulerStatus.triggersEnabled = false;
  gateway.emitSnapshot({ phase: "stopped" });
  expect(page.cron.cronStatus).toMatchObject({ enabled: true, jobs: 0 });
  gateway.emitSnapshot({ phase: "connected" });
  await waitForCronPage(() =>
    expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }),
  );
  expect(callsFor(request, "cron.status")).toHaveLength(2);
  click(page, testId("cron-new-task"));
  await waitForElement(page, "fieldset.cron-editor");
  const triggerToggle = Array.from(page.querySelectorAll(".settings-toggle")).find((toggle) =>
    toggle.textContent?.includes("Condition trigger"),
  );
  expect(triggerToggle).toBeUndefined();
  expect(page.textContent).toContain("disabled by cron.triggers.enabled");
});

it.each([false, true])(
  "does not retain another scope's inventory after refresh failure (loaded=%s)",
  async (loaded) => {
    const earlier = createDeferred<CronJobsListResult>();
    const current = createDeferred<CronJobsListResult>();
    const currentRequested = createDeferred();
    let reads = 0;
    const client = createTestGatewayClient(() => {
      if (++reads === 1) {
        return earlier.promise;
      }
      currentRequested.resolve();
      return current.promise;
    });
    const state = createInitialCronState({ client, connected: true });
    const loading = loadCronJobsPage(state);
    let refreshing: Promise<void> | undefined;
    const olderPage = cronListResponse([
      createCronViewJob("other-agent-job", { agentId: "other" }),
    ]);
    try {
      if (loaded) {
        earlier.resolve(olderPage);
        await loading;
      }
      state.cronAgentId = "main";
      refreshing = loadCronJobsPage(state);
      earlier.resolve(olderPage);
      await currentRequested.promise;
      expect(state.cronJobs).toEqual([]);
      current.reject(new Error("Current scope unavailable"));
      await Promise.all([loading, refreshing]);
      expect(state.cronJobs).toEqual([]);
      expect(state.cronJobsError).toBe("Current scope unavailable");
    } finally {
      earlier.resolve(cronListResponse([]));
      current.resolve(cronListResponse([]));
      await Promise.all([loading, refreshing]);
    }
  },
);

it.each(["hello", "roster after same-scope intent", "roster after model catalog"])(
  "opens the linked editor when %s supplies the initial agent scope after mount",
  async (publication) => {
    const job = createCronViewJob("linked-job", { name: "Linked automation" });
    const roster = createDeferred<AgentsListResult>();
    const lookup = createDeferred<CronJob>();
    const fallback = createRequest();
    const changingCatalog = publication === "roster after model catalog";
    const client = createTestGatewayClient((method, params) => {
      if (method === "agents.list") {
        return roster.promise;
      }
      if (method === "cron.get") {
        return lookup.promise;
      }
      if (method === "models.list" && changingCatalog) {
        if (asOptionalRecord(params)?.agentId === "previous") {
          return { models: [{ id: "previous-model" }] };
        }
        throw new Error("Current agent catalog unavailable");
      }
      return fallback(method);
    });
    const gateway = createGateway(client, false);
    const agents = createAgentCapability(gateway);
    const agentSelection = createAgentSelectionCapability(gateway, agents);
    const page = createPage(
      { ...createContext(gateway), agents, agentSelection },
      { render: true },
    );
    page.routeSearch = `?job=${job.id}`;
    const agentList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    };
    const edited = publication === "roster after same-scope intent" || changingCatalog;
    try {
      await page.settle();
      expect(agentSelection.state.scopeId).toBeNull();
      gateway.emitSnapshot({
        phase: "connected",
        assistantAgentId: changingCatalog ? "previous" : publication === "hello" ? "main" : null,
      });
      await page.settle();
      if (changingCatalog) {
        await expectModels(page, ["previous-model"]);
      }
      if (edited) {
        lookup.resolve(job);
        await waitForElement(page, "#cron-name");
        fillInput(page, "#cron-name", "Unsaved name");
        await page.settle();
        if (publication === "roster after same-scope intent") {
          agentSelection.setScope(null);
        }
      }
      roster.resolve(agentList);
      await agents.ensureList();
      expect(agentSelection.state.scopeId).toBe("main");
      lookup.resolve(job);
      if (changingCatalog) {
        await waitForCronPage(() =>
          expect(page.textContent).toContain("Current agent catalog unavailable"),
        );
        expect(page.cronModelSuggestions).toEqual([]);
      }
      await waitForCronPage(() => {
        expect(text(page, ".cron-detail-title") ?? "").toContain(job.name);
        expect(page.querySelector("details.cron-advanced > summary")).not.toBeNull();
        expect(inputValue(page, "#cron-name")).toBe(edited ? "Unsaved name" : job.name);
      });
    } finally {
      page.remove();
      agentSelection.dispose();
      agents.dispose();
      roster.resolve(agentList);
      lookup.resolve(job);
    }
  },
);

it("refreshes off-page condition activity without replacing unsaved settings", async () => {
  const selected = createCronViewJob("selected-runtime", {
    name: "Saved automation",
    configRevision: "saved-definition",
    trigger: { script: "return true" },
    state: { triggerEvalCount: 1, nextRunAtMs: Date.now() + 60_000 },
  });
  const pending = createDeferred<CronJob>();
  const trailing = createDeferred<CronJob>();
  let reads = 0;
  const request = cronRpc({
    "cron.get": (params) => {
      expect(params).toEqual({ id: selected.id });
      reads += 1;
      return reads === 1 ? selected : reads === 2 ? pending.promise : trailing.promise;
    },
  });
  const { page, gateway } = mountCronPage(request);
  page.routeSearch = `?job=${selected.id}`;
  try {
    await waitForElement(page, "#cron-name");
    fillInput(page, "#cron-name", "Unsaved automation");
    await page.settle();
    const definition = page.cron.cronEditingJob;
    const draft = page.cron.cronForm;
    const previousHeader = text(page, ".cron-detail-meta");
    emitEvent(gateway, "cron", { jobId: selected.id, action: "finished" }, 2);
    pending.resolve({
      ...selected,
      name: "Remote definition",
      configRevision: "remote-definition",
      state: { triggerEvalCount: 7, nextRunAtMs: Date.now() + 86_400_000 },
    });
    trailing.resolve({ ...selected, state: { triggerEvalCount: 9 } });
    await waitForCronPage(() => {
      expect(text(page, ".cron-detail-meta")).not.toBe(previousHeader);
      expect(page.cron.cronEditingJob?.state?.triggerEvalCount).toBe(9);
    });
    expect(reads).toBe(3);
    expect(page.cron.cronJobs).toEqual([]);
    expect(page.cron.cronEditingJob).toBe(definition);
    expect(page.cron.cronEditingJob?.configRevision).toBe("saved-definition");
    expect(text(page, ".cron-detail-title")).toContain("Saved automation");
    expect(page.cron.cronForm).toBe(draft);
    expect(inputValue(page, "#cron-name")).toBe("Unsaved automation");
    page
      .querySelector<HTMLElement>(testId("cron-detail-tab-history"))!
      .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await waitForCronPage(() =>
      expect(text(page, ".cron-condition-activity__metric dd")).toBe("9"),
    );
  } finally {
    page.remove();
    pending.resolve(selected);
    trailing.resolve(selected);
  }
});

const refreshMethods = ["cron.status", "cron.list", "cron.runs"];

function controlVisibility(initial: DocumentVisibilityState = "visible") {
  let value = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => value);
  return (next: DocumentVisibilityState) => {
    value = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

function settle() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

it("defers a hidden mount and reconnect, then catches up once with the current scope", async () => {
  const visibility = controlVisibility("hidden");
  const request = createRequest();
  const { page, gateway, context } = mountCronPage(request, { render: false });
  await page.settle();
  gateway.emitSnapshot({ phase: "stopped" });
  context.agentSelection.setScope("writer");
  gateway.emitSnapshot({ phase: "connected" });
  emitEvent(gateway, "cron", {}, 20);
  await settle();
  expect(request.mock.calls.filter(([method]) => refreshMethods.includes(method))).toEqual([]);
  expect(context.channels.refresh).not.toHaveBeenCalled();
  visibility("visible");
  globalThis.dispatchEvent(new Event("focus"));
  await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
  await settle();
  expectCalls(request, refreshMethods, 1);
  expect(request).toHaveBeenCalledWith("cron.list", expect.objectContaining({ agentId: "writer" }));
  expect(context.channels.refresh).toHaveBeenCalledTimes(1);
  page.remove();
  request.mockClear();
  visibility("hidden");
  visibility("visible");
  expect(request).not.toHaveBeenCalled();
});

it.each([true, false])(
  "keeps a queued burst paused when its reads finish while hidden=%s",
  async (finishHidden) => {
    const visibility = controlVisibility();
    const held = createDeferred();
    let hold = true;
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (hold && refreshMethods.includes(method)) {
        await held.promise;
      }
      return fallback(method);
    });
    const { page, gateway } = mountCronPage(request, { render: false });
    try {
      await page.settle();
      const current = page.cron;
      current.cronJobsQuery = "keep my filter";
      current.cronCreateOpen = true;
      current.cronForm.name = "Unsaved automation";
      emitEvent(gateway, "cron", {}, 20);
      visibility("hidden");
      current.cronRunsQuery = "keep my history filter";
      hold = false;
      if (finishHidden) {
        held.resolve();
        await settle();
      }
      expectCalls(request, refreshMethods, 1);
      visibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      held.resolve();
      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
      await settle();
      expectCalls(request, refreshMethods, 2);
      expect(page.cron).toBe(current);
      expect(current).toMatchObject({
        cronCreateOpen: true,
        cronForm: { name: "Unsaved automation" },
      });
      expect(request.mock.calls.findLast(([method]) => method === "cron.list")?.[1]).toMatchObject({
        query: "keep my filter",
      });
      expect(request.mock.calls.findLast(([method]) => method === "cron.runs")?.[1]).toMatchObject({
        query: "keep my history filter",
      });
    } finally {
      held.resolve();
      page.remove();
    }
  },
);

it("rebinds hidden catch-up to the replacement Gateway", async () => {
  const visibility = controlVisibility();
  const held = createDeferred();
  const fallback = createRequest();
  const oldRequest = vi.fn(async (method: string) => {
    if (refreshMethods.includes(method)) {
      await held.promise;
    }
    return fallback(method);
  });
  const { gateway: oldGateway, page } = mountCronPage(oldRequest, { render: false });
  try {
    await page.settle();
    emitEvent(oldGateway);
    visibility("hidden");
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    page.context = createContext(gateway, "writer");
    page.refreshView();
    await page.settle();
    held.resolve();
    await settle();
    expect(request).not.toHaveBeenCalled();
    expectCalls(oldRequest, refreshMethods, 1);
    oldRequest.mockClear();
    visibility("visible");
    globalThis.dispatchEvent(new Event("focus"));
    emitEvent(oldGateway);
    await settle();
    expectCalls(request, refreshMethods, 1);
    expect(oldRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "writer" }),
    );
  } finally {
    held.resolve();
    page.remove();
  }
});

it("finishes an accepted create-and-run chain while hidden without background readbacks", async () => {
  const visibility = controlVisibility();
  const saved = createDeferred();
  const request = cronRpc({
    "cron.add": async () => {
      await saved.promise;
      return { id: "created-job" };
    },
    "cron.run": () => ({ ok: true, enqueued: true, runId: "synthetic-run" }),
  });
  const { page } = mountCronPage(request);
  try {
    await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
    click(page, testId("cron-new-task"));
    await page.settle();
    for (const [selector, value] of [
      ["#cron-name", "Synthetic task"],
      ["#cron-payload-text", "Synthetic prompt"],
    ] as const) {
      fillInput(page, selector, value);
    }
    await page.settle();
    click(page, testId("cron-submit-run"));
    await waitForCronPage(() =>
      expect(request.mock.calls.some(([method]) => method === "cron.add")).toBe(true),
    );
    visibility("hidden");
    request.mockClear();
    saved.resolve();
    await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
    expect(request).toHaveBeenCalledExactlyOnceWith("cron.run", {
      id: "created-job",
      mode: "force",
    });
    expect(page.cron.cronNotice).toContain("Run queued. Run ID: synthetic-run");
    expect(page.cron.cronCreateOpen).toBe(false);
    visibility("visible");
    await settle();
    expectCalls(request, refreshMethods, 1);
  } finally {
    saved.resolve();
    page.remove();
  }
});
