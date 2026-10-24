import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import * as dom from "./cron-assertions.test-support.ts";
import {
  type CronTestPage,
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage, emitEvent } from "./cron-rpc.test-support.ts";
import { createCronViewJob, createCronViewRun, cronRunsResponse } from "./view.test-support.ts";

const cleanups: Array<() => unknown> = [];
const refreshMethods = ["cron.status", "cron.list", "cron.runs"];
const schedulerStatus = (jobs = 0) => ({ enabled: true, triggersEnabled: true, jobs });
const agentList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main" }],
};

function deferred<T>(fallback: T) {
  const result = createDeferred<T>();
  cleanups.push(() => result.resolve(fallback));
  return result;
}

const gate = () => deferred<void>(undefined);

async function openDraft(page: CronTestPage, name: string, prompt: string) {
  dom.click(page, dom.testId("cron-new-task"));
  await dom.waitForElement(page, "fieldset.cron-editor");
  dom.fillInput(page, "#cron-name", name);
  dom.fillInput(page, "#cron-payload-text", prompt);
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

function expectModels(page: CronTestPage, models: string[]) {
  return waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(models));
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

it.each([{ restartPending: true }, { suspensionPhase: "draining" as const }, null])(
  "pauses background reads during %j and catches up without replacing the draft",
  async (unavailable) => {
    vi.useFakeTimers();
    const visibility = controlVisibility();
    const status = schedulerStatus();
    const request = createRequest(status);
    const methods = unavailable ? [...refreshMethods, "models.list"] : refreshMethods;
    const gateway = createGateway(createTestGatewayClient(request), true);
    const availability = (ready: boolean) =>
      unavailable
        ? gateway.emitSnapshot(
            ready ? { restartPending: false, suspensionPhase: "accepting" } : unavailable,
          )
        : visibility(ready ? "visible" : "hidden");
    availability(false);
    const context = createContext(gateway);
    Object.assign(context.runtimeConfig.state, {
      configForm: { cron: { triggers: { enabled: true } } },
      configNeedsApply: true,
    });
    const page = createPage(context, { render: true });
    await page.settle();
    gateway.emitSnapshot({ phase: "stopped" });
    context.agentSelection.setScope("writer");
    gateway.emitSnapshot({ phase: "connected" });
    emitEvent(gateway, "cron", {}, 20);
    await vi.advanceTimersByTimeAsync(0);
    dom.expectCalls(request, methods, 0);
    availability(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "writer" }),
    );
    const current = page.cron;
    current.cronCreateOpen = true;
    current.cronForm.name = "Unsaved automation";
    page.context = { ...context };
    page.refreshView();
    await page.settle();
    request.mockClear();
    availability(false);
    status.triggersEnabled = false;
    gateway.emitSnapshot({ phase: "stopped" });
    gateway.emitSnapshot({ phase: "connected" });
    emitEvent(gateway, "cron");
    emitEvent(gateway, "config.changed");
    await vi.advanceTimersByTimeAsync(600_000);
    dom.expectCalls(request, methods, 0);
    availability(true);
    await vi.advanceTimersByTimeAsync(0);
    dom.expectCalls(request, methods, 1);
    expect(current).toMatchObject({
      cronCreateOpen: true,
      cronForm: { name: "Unsaved automation" },
    });
    expect(current.cronStatus?.triggersEnabled).toBe(false);
    expect(
      Array.from(page.querySelectorAll(".settings-toggle")).some((toggle) =>
        toggle.textContent?.includes("Condition trigger"),
      ),
    ).toBe(false);
    expect(page.textContent).toContain("disabled by cron.triggers.enabled");
  },
);

it("saves the selected provider-qualified model without exposing hidden catalog entries", async () => {
  const request = cronRpc({
    "models.list": () => ({
      models: [
        { provider: "alpha", id: "shared-model" },
        { provider: "beta", id: "shared-model" },
        { provider: "beta", id: "beta/shared-model" },
        { provider: "beta", id: "hidden-model", manualSelectionAllowed: false },
      ],
    }),
    "cron.add": () => ({ id: "identity-job" }),
  });
  const { page } = mountCronPage(request);
  await openDraft(page, "Provider identity", "Use the selected model");
  const trigger = page.querySelector<HTMLButtonElement>("#cron-payload-model-picker")!;
  const picker = trigger.closest("openclaw-select-picker")!;
  trigger.click();
  await waitForCronPage(() => {
    const values = Array.from(
      picker.querySelectorAll<HTMLElement>('[role="option"]'),
      (option) => option.dataset.value,
    );
    expect(values.filter((value) => value?.includes("shared-model"))).toEqual([
      "alpha/shared-model",
      "beta/shared-model",
    ]);
    expect(values).not.toContain("beta/hidden-model");
  });
  picker.querySelector<HTMLElement>('[role="option"][data-value="beta/shared-model"]')!.click();
  await page.settle();
  dom.click(page, dom.testId("cron-submit"));
  await waitForCronPage(() =>
    expect(dom.callsFor(request, "cron.add")[0]?.[1]).toHaveProperty("payload", {
      kind: "agentTurn",
      message: "Use the selected model",
      model: "beta/shared-model",
    }),
  );
});

it("refreshes model suggestions when team selection changes without changing scope", async () => {
  const lateMain = deferred<{ models: { id: string }[] }>({ models: [] });
  const writer = deferred<{ models: { id: string }[] }>({ models: [] });
  let mainReads = 0;
  const client = createTestGatewayClient(
    cronRpc({
      "models.list": (params) => {
        const agentId = asOptionalRecord(params)?.agentId;
        if (agentId === "writer") {
          return writer.promise;
        }
        mainReads += 1;
        return mainReads === 1 ? { models: [{ id: "main-model" }] } : lateMain.promise;
      },
    }),
  );
  const gateway = createGateway(client, true);
  gateway.emitSnapshot({ assistantAgentId: "main" });
  const context = createContext(gateway, null, "main");
  context.agents.state.agentsList = { ...agentList, agents: [{ id: "main" }, { id: "writer" }] };
  const agentSelection = createAgentSelectionCapability(gateway, context.agents, undefined, {
    settings: { gatewayUrl: "", sidebarAgentsMode: "roster", sidebarPreTeamScope: undefined },
    patch: () => undefined,
    subscribe: () => () => undefined,
  });
  const page = createPage({ ...context, agentSelection }, { render: true });
  cleanups.push(() => agentSelection.dispose());
  await expectModels(page, ["main-model"]);
  emitEvent(gateway, "chat.metadata.changed");
  await page.settle();
  agentSelection.set("writer");
  expect(agentSelection.state).toEqual({ selectedId: "writer", scopeId: null });
  await expectModels(page, []);
  writer.resolve({ models: [{ id: "writer-model" }] });
  await expectModels(page, ["writer-model"]);
  lateMain.resolve({ models: [{ id: "late-main-model" }] });
  await lateMain.promise;
  await page.settle();
  expect(page.cronModelSuggestions).toEqual(["writer-model"]);
});

it("applies run events to the complete job table without fetching the inventory again", async () => {
  const job = createCronViewJob("running-job", { state: { nextRunAtMs: 100 } });
  const other = createCronViewJob("other-job", { state: { nextRunAtMs: 200 } });
  const request = cronRpc({ "cron.list": () => cronListResponse(structuredClone([job, other])) });
  const { page, gateway } = mountCronPage(request);
  await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(2));
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
  expect(dom.callsFor(request, "cron.list")).toHaveLength(0);
});

it.each(["manual", "hidden completion", "visible completion"])(
  "refresh handoff preserves current data and drafts: %s",
  async (mode) => {
    const visibility = controlVisibility();
    const job = createCronViewJob("fresh-job", { configRevision: "fresh-config", state: {} });
    const run = createCronViewRun({ ts: 2, jobId: job.id });
    const fresh = cronRpc({
      "cron.status": () => schedulerStatus(1),
      "cron.list": () => cronListResponse([job]),
      "cron.runs": () => cronRunsResponse([run]),
    });
    const stale = createRequest();
    const { request, held, resume } = heldRequest(
      (method, pending) => (pending ? stale(method) : fresh(method)),
      mode === "manual" ? ["cron.status", "cron.runs"] : refreshMethods,
    );
    const { page, gateway } = mountCronPage(request, { render: mode === "manual" });
    await page.settle();
    if (mode === "manual") {
      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
    }
    const current = page.cron;
    current.cronJobsQuery = "keep my filter";
    current.cronRunsQuery = "keep my history filter";
    current.cronCreateOpen = mode !== "manual";
    current.cronForm.name = "Unsaved automation";
    dom.expectCalls(request, refreshMethods, 1);
    if (mode === "manual") {
      resume();
      dom.click(page, ".cron-refresh");
    } else {
      emitEvent(gateway, "cron", {}, 20);
      visibility("hidden");
      resume();
      if (mode === "hidden completion") {
        held.resolve();
        await settle();
      }
      dom.expectCalls(request, refreshMethods, 1);
      visibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      held.resolve();
    }
    await waitForCronPage(() => {
      expect(current.cronStatus?.jobs).toBe(1);
      expect(current.cronJobs).toEqual([job]);
      expect(current.cronRuns).toEqual([run]);
    });
    held.resolve();
    await settle();
    expect(current.cronStatus?.jobs).toBe(1);
    expect(current.cronRuns).toEqual([run]);
    dom.expectCalls(request, refreshMethods, 2);
    expect(current.cronForm.name).toBe("Unsaved automation");
    expect(current.cronCreateOpen).toBe(mode !== "manual");
    for (const [method, query] of [
      ["cron.list", "keep my filter"],
      ["cron.runs", "keep my history filter"],
    ]) {
      expect(request.mock.calls.findLast(([called]) => called === method)?.[1]).toMatchObject({
        query,
      });
    }
  },
);

it.each(["disconnect", "reconnect", "agent scope", "gateway source", "hidden gateway", "unmount"])(
  "retires queued refreshes and pending catalog errors on %s",
  async (change) => {
    const visibility = controlVisibility();
    const replacement = change === "hidden gateway" ? createRequest() : null;
    const fallback = createRequest();
    const catalog = gate();
    const models = vi
      .fn()
      .mockReturnValueOnce({ models: [{ id: "initial-model" }] })
      .mockReturnValueOnce(catalog.promise)
      .mockReturnValue({ models: [{ id: "current-model" }] });
    const retired = cronRpc(
      {
        "cron.status": () => schedulerStatus(99),
        "cron.list": () => cronListResponse([createCronViewJob("retired-job")]),
        "cron.runs": () => cronRunsResponse([createCronViewRun({ ts: 99, jobId: "retired-job" })]),
      },
      fallback,
    );
    const { request, held, resume } = heldRequest((method, pending) =>
      method === "models.list" ? models() : pending ? retired(method) : fallback(method),
    );
    const { page, client, gateway, context } = mountCronPage(request);
    await expectModels(page, ["initial-model"]);
    emitEvent(gateway, "config.changed");
    await waitForCronPage(() => expect(models).toHaveBeenCalledTimes(2));
    emitEvent(gateway);
    resume();
    if (change === "disconnect" || change === "reconnect") {
      gateway.emitSnapshot({ phase: "stopped" });
      if (change === "reconnect") {
        gateway.emitSnapshot({ phase: "connected" });
      }
    } else if (change === "agent scope") {
      context.agentSelection.setScope("writer");
    } else if (change === "gateway source" || replacement) {
      if (replacement) {
        visibility("hidden");
      }
      const next = replacement
        ? ({ request: replacement } as unknown as GatewayBrowserClient)
        : client;
      page.context = createContext(createGateway(next, true), replacement ? "writer" : "main");
      page.refreshView();
    } else {
      page.remove();
    }
    await page.settle();
    const count = request.mock.calls.length;
    catalog.reject(new Error("Retired catalog error"));
    await Promise.allSettled([catalog.promise]);
    held.resolve();
    await settle();
    if (replacement) {
      expect(replacement).not.toHaveBeenCalled();
      visibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      emitEvent(gateway);
      await settle();
      dom.expectCalls(replacement, refreshMethods, 1);
      expect(replacement).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ agentId: "writer" }),
      );
    }
    expect(request).toHaveBeenCalledTimes(count);
    expect(page.textContent).not.toContain("Retired catalog error");
    if (change === "unmount") {
      expect(page.isConnected).toBe(false);
      expect(page.childElementCount).toBe(0);
    } else {
      expect(page.cron.cronError).toBeNull();
      expect(page.cron.cronStatus?.jobs).not.toBe(99);
      expect(page.cron.cronJobs.some((job) => job.id === "retired-job")).toBe(false);
      expect(page.cron.cronRuns.some((run) => run.jobId === "retired-job")).toBe(false);
      if (change !== "disconnect" && !replacement) {
        await expectModels(page, ["current-model"]);
      }
    }
  },
);

it.each([false, true])(
  "does not retain another scope's inventory after refresh failure (loaded=%s)",
  async (loaded) => {
    const earlier = deferred(cronListResponse([]));
    const current = deferred(cronListResponse([]));
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
    const pending = [loading];
    cleanups.unshift(() => Promise.all(pending));
    const olderPage = cronListResponse([
      createCronViewJob("other-agent-job", { agentId: "other" }),
    ]);
    if (loaded) {
      earlier.resolve(olderPage);
      await loading;
    }
    state.cronAgentId = "main";
    pending.push(loadCronJobsPage(state));
    earlier.resolve(olderPage);
    await currentRequested.promise;
    expect(state.cronJobs).toEqual([]);
    current.reject(new Error("Current scope unavailable"));
    await Promise.all(pending);
    expect(state.cronJobs).toEqual([]);
    expect(state.cronJobsError).toBe("Current scope unavailable");
  },
);

it.each(["hello", "roster after same-scope intent", "roster after model catalog"])(
  "opens the linked editor when %s supplies the initial agent scope after mount",
  async (publication) => {
    const job = createCronViewJob("linked-job", { name: "Linked automation" });
    const roster = deferred(agentList);
    const lookup = deferred(job);
    const changingCatalog = publication === "roster after model catalog";
    const fallback = createRequest();
    const client = createTestGatewayClient(
      cronRpc(
        {
          "agents.list": () => roster.promise,
          "cron.get": () => lookup.promise,
          "models.list": (params) => {
            if (!changingCatalog) {
              return fallback("models.list");
            }
            if (asOptionalRecord(params)?.agentId === "previous") {
              return { models: [{ id: "previous-model" }] };
            }
            throw new Error("Current agent catalog unavailable");
          },
        },
        fallback,
      ),
    );
    const gateway = createGateway(client, false);
    const agents = createAgentCapability(gateway);
    const agentSelection = createAgentSelectionCapability(gateway, agents);
    const page = createPage(
      { ...createContext(gateway), agents, agentSelection },
      { render: true },
    );
    cleanups.push(() => {
      agentSelection.dispose();
      agents.dispose();
    });
    page.routeSearch = "?job=" + job.id;
    const edited = publication !== "hello";
    await page.settle();
    expect(agentSelection.state.scopeId).toBeNull();
    gateway.emitSnapshot({
      phase: "connected",
      assistantAgentId: changingCatalog ? "previous" : edited ? null : "main",
    });
    await page.settle();
    if (changingCatalog) {
      await expectModels(page, ["previous-model"]);
    }
    if (edited) {
      lookup.resolve(job);
      await dom.waitForElement(page, "#cron-name");
      dom.fillInput(page, "#cron-name", "Unsaved name");
      await page.settle();
      if (!changingCatalog) {
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
      expect(dom.text(page, ".cron-detail-title")).toContain(job.name);
      expect(dom.inputValue(page, "#cron-name")).toBe(edited ? "Unsaved name" : job.name);
    });
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
  const replies = [selected, pending.promise, trailing.promise];
  const { page, gateway } = mountCronPage(cronRpc({ "cron.get": () => replies.shift() }));
  page.routeSearch = `?job=${selected.id}`;
  await dom.waitForElement(page, "#cron-name");
  dom.fillInput(page, "#cron-name", "Unsaved automation");
  await page.settle();
  emitEvent(gateway, "cron", { jobId: selected.id, action: "finished" }, 2);
  pending.resolve({
    ...selected,
    name: "Remote definition",
    configRevision: "remote-definition",
    state: { triggerEvalCount: 7, nextRunAtMs: Date.now() + 86_400_000 },
  });
  trailing.resolve({ ...selected, state: { triggerEvalCount: 9 } });
  await waitForCronPage(() => expect(page.cron.cronEditingJob?.state?.triggerEvalCount).toBe(9));
  expect(page.cron.cronJobs).toEqual([]);
  expect(page.cron.cronEditingJob?.configRevision).toBe("saved-definition");
  expect(dom.text(page, ".cron-detail-title")).toContain("Saved automation");
  expect(dom.inputValue(page, "#cron-name")).toBe("Unsaved automation");
});

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
  await openDraft(page, "Synthetic task", "Synthetic prompt");
  dom.click(page, dom.testId("cron-submit-run"));
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
  dom.expectCalls(request, refreshMethods, 1);
});
