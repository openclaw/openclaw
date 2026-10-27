import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, CronJobsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
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
  waitForCronPage as waitFor,
} from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage, emitEvent } from "./cron-rpc.test-support.ts";
import {
  createCronViewJob,
  createCronViewRun,
  cronRunsResponse,
  getElement,
} from "./view.test-support.ts";
import "./cron-page.tsx";

const cleanups: Array<() => unknown> = [];
const refreshMethods = ["cron.status", "cron.list", "cron.runs"];
const schedulerStatus = (jobs = 0) => ({ enabled: true, triggersEnabled: true, jobs });

function deferred<T>(fallback: T) {
  const result = createDeferred<T>();
  cleanups.push(() => result.resolve(fallback));
  return result;
}

const gate = () => deferred<void>(undefined);

async function openDraft(page: CronTestPage, name: string, prompt: string) {
  click(page, testId("cron-new-task"));
  await waitForElement(page, "fieldset.cron-editor");
  fillInput(page, "#cron-name", name);
  fillInput(page, "#cron-payload-text", prompt);
  await page.settle();
}

function heldRequest(
  respond: (method: string, pending: boolean) => unknown = createRequest(),
  methods = refreshMethods,
) {
  const held = gate();
  let holding = true;
  const request = vi.fn(async (method: string, _params?: unknown) => {
    const pending = holding;
    if (pending && methods.includes(method)) {
      await held.promise;
    }
    return respond(method, pending);
  });
  return {
    request,
    held,
    resume: () => {
      holding = false;
    },
  };
}

function modelClient(read: (params?: unknown) => unknown) {
  return createTestGatewayClient(cronRpc({ "models.list": read }));
}

function expectModels(page: CronTestPage, models: string[]) {
  return waitFor(() => expect(page.cronModelSuggestions).toEqual(models));
}

afterEach(async () => {
  cleanupSolid();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
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
    request.mockClear();
    gateway.emitSnapshot(unavailable);
    emitEvent(gateway, "cron");
    emitEvent(gateway, "config.changed");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(request).not.toHaveBeenCalled();
    gateway.emitSnapshot({ restartPending: false, suspensionPhase: "accepting" });
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(request, [...refreshMethods, "models.list"], 1);
    expect(page.cron).toMatchObject({
      cronCreateOpen: true,
      cronForm: { name: "Unsaved automation" },
    });
  },
);

it("shows an empty catalog failure and clears it after recovery", async () => {
  let result = {
    models: [{ provider: "fixture", id: "obsolete", name: "Obsolete model" }],
    refreshFailed: false,
  };
  const { page, gateway } = mountCronPage(modelClient(() => result));
  await expectModels(page, ["fixture/obsolete"]);
  result = {
    models: [],
    refreshFailed: true,
  };
  emitEvent(gateway, "chat.metadata.changed");
  await expectModels(page, []);
  expect(page.textContent).toContain("Models unavailable");
  result = { models: [], refreshFailed: false };
  emitEvent(gateway, "chat.metadata.changed");
  await waitFor(() => expect(page.textContent).not.toContain("Models unavailable"));
  await expectModels(page, []);
});

it.each(["agent", "connection", "detach"])(
  "rejects a pending catalog error after %s changes",
  async (change) => {
    const oldError = gate();
    const read = vi
      .fn()
      .mockReturnValueOnce({ models: [{ id: "initial-model" }] })
      .mockReturnValueOnce(oldError.promise)
      .mockReturnValue({ models: [{ id: "current-model" }] });
    const client = modelClient(read);
    const { page, gateway, context } = mountCronPage(client);
    await expectModels(page, ["initial-model"]);
    emitEvent(gateway, "config.changed");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(page.cronModelSuggestions).toEqual(["initial-model"]);
    if (change === "agent") {
      context.agentSelection.set("writer");
    } else if (change === "connection") {
      gateway.emitSnapshot({ phase: "reconnecting" });
      gateway.emitSnapshot({ phase: "connected" });
    } else {
      page.remove();
    }
    const readsBeforeCompletion = read.mock.calls.length;
    oldError.reject(new Error("Retired catalog error"));
    await Promise.allSettled([oldError.promise]);
    if (change === "detach") {
      await page.settle();
      expect(page).toMatchObject({ isConnected: false, childElementCount: 0 });
      expect(read).toHaveBeenCalledTimes(readsBeforeCompletion);
    } else {
      await expectModels(page, ["current-model"]);
      await page.settle();
    }
    expect(page.textContent).not.toContain("Retired catalog error");
  },
);

it("keeps provider choices and new-task ownership on the selected agent without changing team scope", async () => {
  const models = [
    { provider: "alpha", id: "shared-model", name: "Alpha shared" },
    { provider: "beta", id: "shared-model", name: "Beta shared" },
    {
      provider: "beta",
      id: "hidden-model",
      name: "Hidden model",
      manualSelectionAllowed: false,
    },
  ];
  const lateMain = deferred<{ models: { id: string }[] }>({ models: [] });
  const writer = deferred({ models: models.slice(0, 0) });
  let mainReads = 0;
  const read = vi.fn((params?: unknown) => {
    const agentId = (params as { agentId?: string } | undefined)?.agentId;
    if (agentId === "writer") {
      return writer.promise;
    }
    mainReads += 1;
    return mainReads === 1 ? { models: [{ id: "main-model" }] } : lateMain.promise;
  });
  const request = cronRpc({ "models.list": read, "cron.add": () => ({ id: "identity-job" }) });
  const client = createTestGatewayClient(request);
  const gateway = createGateway(client, true);
  gateway.emitSnapshot({ assistantAgentId: "main", hello: operatorHello(["operator.admin"]) });
  const agentSelection = createAgentSelectionCapability(
    gateway,
    {
      state: {
        agentsList: makeBootRoster({ agents: [{ id: "main" }, { id: "writer" }] }),
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
  cleanups.push(() => agentSelection.dispose());
  await expectModels(page, ["main-model"]);
  emitEvent(gateway, "chat.metadata.changed");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  agentSelection.set("writer");
  expect(agentSelection.state).toEqual({ selectedId: "writer", scopeId: null });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(page.cronModelSuggestions).toEqual([]);
  writer.resolve({ models });
  await expectModels(page, ["alpha/shared-model", "beta/shared-model"]);
  lateMain.resolve({ models: [{ id: "late-main-model" }] });
  await lateMain.promise;
  await page.settle();
  expect(page.cronModelSuggestions).toEqual(["alpha/shared-model", "beta/shared-model"]);
  await openDraft(page, "Provider identity", "Use the selected model");
  const trigger = page.querySelector<HTMLButtonElement>("#cron-payload-model-picker")!;
  const picker = trigger.closest("openclaw-select-picker")!;
  trigger.click();
  const choice = await waitForElement(picker, '[role="option"][data-value="beta/shared-model"]');
  expect(text(picker, '[role="option"][data-value=""]')).toContain("Default");
  choice.click();
  await page.settle();
  const save = page.querySelector<HTMLButtonElement>(testId("cron-submit"))!;
  expect(save.disabled).toBe(false);
  save.click();
  await waitFor(() => {
    const adds = callsFor(request, "cron.add");
    expect(adds.at(-1)?.[1]).toHaveProperty("payload.model", "beta/shared-model");
  });
  await waitFor(() => expect(page.cron.cronBusy).toBe(false));
  expect(callsFor(request, "cron.add").at(-1)?.[1]).toMatchObject({
    agentId: "writer",
    delivery: { mode: "none" },
    name: "Provider identity",
  });
});

it("applies run events to the complete job table without fetching the inventory again", async () => {
  const job = createCronViewJob("running-job", { state: { nextRunAtMs: 100 } });
  const other = createCronViewJob("other-job", { state: { nextRunAtMs: 200 } });
  const request = cronRpc({
    "cron.list": () => cronListResponse(structuredClone([job, other])),
  });
  const { page, gateway } = mountCronPage(request);
  await waitFor(() => expect(page.cron.cronJobs).toHaveLength(2));
  await page.settle();
  request.mockClear();
  const emitRun = (action: "started" | "finished", updatedAtMs: number, state: typeof job.state) =>
    emitEvent(gateway, "cron", {
      action,
      jobId: job.id,
      ...(action === "finished" ? { status: "ok", durationMs: 10 } : {}),
      job: { id: job.id, name: job.name, enabled: true, updatedAtMs, state },
    });
  emitRun("started", 1, { nextRunAtMs: 100, runningAtMs: 100 });
  await page.settle();
  expect(page.cron.cronJobs[0]?.state.runningAtMs).toBe(100);
  expect(callsFor(request, "cron.list"), "started event").toHaveLength(0);
  emitRun("finished", 2, { nextRunAtMs: 300, lastRunAtMs: 100, lastRunStatus: "ok" });
  await page.settle();
  expect(page.cron.cronJobs.map((entry) => entry.id)).toEqual([other.id, job.id]);
  expect(page.cron.cronJobs[1]?.state).toMatchObject({ lastRunStatus: "ok", lastDurationMs: 10 });
  expect(page.cron.cronJobs[1]?.state.runningAtMs).toBeUndefined();
  expect(callsFor(request, "cron.list")).toHaveLength(0);
});

it.each(["event burst", "manual Refresh"])(
  "settles %s without publishing stale reads",
  async (mode) => {
    const manual = mode === "manual Refresh";
    const freshJob = createCronViewJob("fresh-job", { configRevision: "fresh-config", state: {} });
    const freshRun = createCronViewRun({ ts: 2, jobId: freshJob.id });
    const { request, held, resume } = heldRequest(
      (method, stale) => {
        const replies: Record<string, unknown> = {
          "cron.status": schedulerStatus(stale ? 1 : 2),
          "cron.list": cronListResponse(stale ? [] : [freshJob]),
          "cron.runs": cronRunsResponse(stale ? [] : [freshRun]),
          "channels.status": { channelOrder: [], channels: {}, channelAccounts: {} },
        };
        return replies[method] ?? { models: [] };
      },
      manual
        ? ["cron.status", "cron.runs", "channels.status"]
        : [...refreshMethods, "channels.status"],
    );
    const gateway = createGateway(createTestGatewayClient(request), true);
    const channels = createChannelCapability(gateway);
    const page = createPage(
      { ...createContext(gateway), acquireChannels: () => channels },
      { render: manual },
    );
    cleanups.push(() => channels.dispose());
    await page.settle();
    if (manual) {
      await waitFor(() => expect(page.cron.cronLoading).toBe(false));
    } else {
      emitEvent(gateway, "cron", {}, 20);
    }
    expectCalls(request, [...refreshMethods, "channels.status"], 1);
    resume();
    if (manual) {
      getElement(page, ".cron-refresh", HTMLButtonElement).click();
    } else {
      held.resolve();
    }
    await waitFor(() => {
      expect(page.cron.cronStatus?.jobs).toBe(2);
      expect(page.cron.cronJobs).toEqual([freshJob]);
      expect(page.cron.cronRuns).toEqual([freshRun]);
    });
    held.resolve();
    await settle();
    await page.settle();
    expect(page.cron.cronStatus?.jobs).toBe(2);
    expect(page.cron.cronRuns).toEqual([freshRun]);
    expectCalls(request, refreshMethods, 2);
    expect(callsFor(request, "channels.status")).toHaveLength(1);
  },
);

it.each(["disconnect", "reconnect", "agent scope", "gateway source", "unmount"])(
  "retires queued cron event refreshes on %s",
  async (change) => {
    const fallback = createRequest();
    const retired = cronRpc(
      {
        "cron.status": () => schedulerStatus(99),
        "cron.list": () => cronListResponse([createCronViewJob("retired-job")]),
        "cron.runs": () => cronRunsResponse([createCronViewRun({ ts: 99, jobId: "retired-job" })]),
      },
      fallback,
    );
    const { request, held, resume } = heldRequest((method, pending) =>
      pending ? retired(method) : fallback(method),
    );
    const { page, client, gateway, context } = mountCronPage(request, { render: false });
    await page.settle();
    emitEvent(gateway);
    resume();
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
    await waitFor(() =>
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
      expect(page).toMatchObject({ isConnected: false, childElementCount: 0 });
    } else {
      expect(page.cron.cronError).toBeNull();
      expect(page.cron.cronStatus?.jobs).not.toBe(99);
      expect(page.cron.cronJobs.some((job) => job.id === "retired-job")).toBe(false);
      expect(page.cron.cronRuns.some((run) => run.jobId === "retired-job")).toBe(false);
    }
  },
);

it("refreshes trigger authoring from scheduler status after reconnect", async () => {
  const status = schedulerStatus();
  const request = createRequest(status);
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client, true);
  const context = createContext(gateway);
  Object.assign(context.runtimeConfig.state, {
    configForm: { cron: { triggers: { enabled: true } } },
    configNeedsApply: true,
  });
  const page = createPage(context, { render: true });
  await waitFor(() => expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: true }));
  status.triggersEnabled = false;
  gateway.emitSnapshot({ phase: "stopped" });
  expect(page.cron.cronStatus).toMatchObject({ enabled: true, jobs: 0 });
  gateway.emitSnapshot({ phase: "connected" });
  await waitFor(() => expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }));
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
    const earlier = deferred<CronJobsListResult>(cronListResponse([]));
    const current = deferred<CronJobsListResult>(cronListResponse([]));
    const currentRequested = gate();
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
      expect(state).toMatchObject({ cronJobs: [], cronJobsError: "Current scope unavailable" });
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
    const lookup = deferred(job);
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
    const agentList = makeBootRoster();
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
        await waitFor(() =>
          expect(page.textContent).toContain("Current agent catalog unavailable"),
        );
        expect(page.cronModelSuggestions).toEqual([]);
      }
      await waitFor(() => {
        expect(text(page, ".cron-detail-title") ?? "").toContain(job.name);
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
  const pending = deferred(selected);
  const trailing = deferred(selected);
  let reads = 0;
  const request = cronRpc({
    "cron.get": () => {
      reads += 1;
      return reads === 1 ? selected : reads === 2 ? pending.promise : trailing.promise;
    },
  });
  const { page, gateway } = mountCronPage(request);
  page.routeSearch = `?job=${selected.id}`;
  await waitForElement(page, "#cron-name");
  fillInput(page, "#cron-name", "Unsaved automation");
  await page.settle();
  const previousHeader = text(page, ".cron-detail-meta");
  emitEvent(gateway, "cron", { jobId: selected.id, action: "finished" }, 2);
  pending.resolve({
    ...selected,
    name: "Remote definition",
    configRevision: "remote-definition",
    state: { triggerEvalCount: 7, nextRunAtMs: Date.now() + 86_400_000 },
  });
  trailing.resolve({ ...selected, state: { triggerEvalCount: 9 } });
  await waitFor(() => {
    expect(text(page, ".cron-detail-meta")).not.toBe(previousHeader);
    expect(page.cron.cronEditingJob?.state?.triggerEvalCount).toBe(9);
  });
  expect(page.cron.cronJobs).toEqual([]);
  expect(page.cron.cronEditingJob?.configRevision).toBe("saved-definition");
  expect(text(page, ".cron-detail-title")).toContain("Saved automation");
  expect(inputValue(page, "#cron-name")).toBe("Unsaved automation");
  page
    .querySelector<HTMLElement>(testId("cron-detail-tab-history"))!
    .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  await waitFor(() => expect(text(page, ".cron-condition-activity__metric dd")).toBe("9"));
});

function controlVisibility(initial: DocumentVisibilityState = "visible") {
  let value = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => value);
  return (next: DocumentVisibilityState) => {
    value = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
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
  expect(context.acquireChannels(createChannelCapability).refresh).not.toHaveBeenCalled();
  visibility("visible");
  globalThis.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(page.cron.cronStatus).not.toBeNull());
  await settle();
  expectCalls(request, refreshMethods, 1);
  expect(request).toHaveBeenCalledWith("cron.list", expect.objectContaining({ agentId: "writer" }));
  expect(context.acquireChannels(createChannelCapability).refresh).toHaveBeenCalledTimes(1);
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
    const { request, held, resume } = heldRequest();
    const { page, gateway } = mountCronPage(request, { render: false });
    await page.settle();
    const current = page.cron;
    current.cronJobsQuery = "keep my filter";
    current.cronCreateOpen = true;
    current.cronForm.name = "Unsaved automation";
    emitEvent(gateway, "cron", {}, 20);
    visibility("hidden");
    current.cronRunsQuery = "keep my history filter";
    resume();
    if (finishHidden) {
      held.resolve();
      await settle();
    }
    expectCalls(request, refreshMethods, 1);
    visibility("visible");
    globalThis.dispatchEvent(new Event("focus"));
    held.resolve();
    await waitFor(() => expect(page.cron.cronLoading).toBe(false));
    await settle();
    expectCalls(request, refreshMethods, 2);
    expect(page.cron).toMatchObject({
      cronCreateOpen: true,
      cronForm: { name: "Unsaved automation" },
    });
    expect(request.mock.calls.findLast(([method]) => method === "cron.list")?.[1]).toMatchObject({
      query: "keep my filter",
    });
    expect(request.mock.calls.findLast(([method]) => method === "cron.runs")?.[1]).toMatchObject({
      query: "keep my history filter",
    });
  },
);

it("rebinds hidden catch-up to the replacement Gateway", async () => {
  const visibility = controlVisibility();
  const { request: oldRequest, held } = heldRequest();
  const { gateway: oldGateway, page } = mountCronPage(oldRequest, { render: false });
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
  expect(request).toHaveBeenCalledWith("cron.list", expect.objectContaining({ agentId: "writer" }));
});

it("finishes an accepted create-and-run chain while hidden without background readbacks", async () => {
  const visibility = controlVisibility();
  const saved = gate();
  const request = cronRpc({
    "cron.add": async () => {
      await saved.promise;
      return { id: "created-job" };
    },
    "cron.run": () => ({ ok: true, enqueued: true, runId: "synthetic-run" }),
  });
  const { page } = mountCronPage(request);
  await waitFor(() => expect(page.cron.cronStatus).not.toBeNull());
  await openDraft(page, "Synthetic task", "Synthetic prompt");
  click(page, testId("cron-submit-run"));
  await waitFor(() =>
    expect(request.mock.calls.some(([method]) => method === "cron.add")).toBe(true),
  );
  visibility("hidden");
  request.mockClear();
  saved.resolve();
  await waitFor(() => expect(page.cron.cronBusy).toBe(false));
  expect(request).toHaveBeenCalledExactlyOnceWith("cron.run", {
    id: "created-job",
    mode: "force",
  });
  expect(page.cron.cronNotice).toContain("Run queued. Run ID: synthetic-run");
  expect(page.cron.cronCreateOpen).toBe(false);
  visibility("visible");
  await settle();
  expectCalls(request, refreshMethods, 1);
});

function settle() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
