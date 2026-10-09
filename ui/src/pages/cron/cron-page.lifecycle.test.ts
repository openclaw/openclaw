import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, CronJob, CronJobsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it.each(["catalog-needed", "configured-alternative"])(
    "preserves catalog provider identity through model selection and save (%s)",
    async (source) => {
      const configuredAlternatives = source === "configured-alternative";
      const models = [
        { provider: "alpha", id: "shared-model", name: "Alpha shared" },
        { provider: "beta", id: "shared-model", name: "Beta shared" },
        // Keep the catalog-needed cell dependent on qualifying the raw beta row.
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
      const fallback = createRequest();
      const request = vi.fn((method: string, _params?: unknown) => {
        if (method === "models.list") {
          return { models };
        }
        if (method === "cron.add") {
          return { id: "identity-job" };
        }
        if (method === "cron.list") {
          return cronListResponse([]);
        }
        return fallback(method);
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
            providers: {
              alpha: {
                baseUrl: "https://alpha.invalid",
                models: [{ id: "shared-model", name: "Alpha shared" }],
              },
              beta: {
                baseUrl: "https://beta.invalid",
                models: [{ id: "shared-model", name: "Beta shared" }],
              },
            },
          },
        },
      });
      const page = createPage(context, { render: true });
      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
      await page.updateComplete;
      page.querySelector<HTMLButtonElement>('[data-test-id="cron-new-task"]')!.click();
      await waitForCronPage(() =>
        expect(page.querySelector("fieldset.cron-editor")).not.toBeNull(),
      );

      const name = page.querySelector<HTMLInputElement>("#cron-name")!;
      name.value = "Provider identity";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      const prompt = page.querySelector<HTMLTextAreaElement>("#cron-payload-text")!;
      prompt.value = "Use the selected model";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      await waitForCronPage(() => expect(page.cronModelSuggestions.length).toBeGreaterThan(0));
      await page.updateComplete;

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
      });
      picker.querySelector<HTMLElement>('[role="option"][data-value="beta/shared-model"]')!.click();
      await page.updateComplete;
      const save = page.querySelector<HTMLButtonElement>('[data-test-id="cron-submit"]')!;
      expect(save.disabled).toBe(false);
      save.click();
      await waitForCronPage(() => {
        const adds = request.mock.calls.filter(([method]) => method === "cron.add");
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
      const fallback = createRequest();
      let result = {
        models: [{ provider: "fixture", id: "obsolete", name: "Obsolete model" }],
        refreshFailed: false,
      };
      const client = createTestGatewayClient((method) =>
        method === "models.list" ? result : fallback(method),
      );
      const gateway = createGateway(client, true);
      const page = createPage(createContext(gateway), { render: true });
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fixture/obsolete"]));

      result = {
        models: hasRows ? [{ provider: "fixture", id: "current", name: "Current model" }] : [],
        refreshFailed: true,
      };
      gateway.emitRetiredEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForCronPage(() =>
        expect(page.cronModelSuggestions).toEqual(hasRows ? ["fixture/current"] : []),
      );
      expect(page.textContent).toContain(
        hasRows
          ? "Some models could not be refreshed. Open Models to try again."
          : "Models unavailable",
      );

      result = { models: [], refreshFailed: false };
      gateway.emitRetiredEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForCronPage(() =>
        expect(page.textContent).not.toContain(
          hasRows ? "Some models could not be refreshed" : "Models unavailable",
        ),
      );
      expect(page.cronModelSuggestions).toEqual([]);
    },
  );

  it.each(["publication", "agent", "connection", "gateway", "detach"])(
    "rejects a retired catalog result and error after %s changes",
    async (change) => {
      const oldResult = createDeferred<{ models: { id: string }[] }>();
      const oldError = createDeferred();
      const fallback = createRequest();
      let reads = 0;
      const client = createTestGatewayClient((method) => {
        if (method !== "models.list") {
          return fallback(method);
        }
        reads += 1;
        if (reads === 1) {
          return oldResult.promise;
        }
        if (reads === 2) {
          return oldError.promise;
        }
        return { models: [{ id: "current-model" }] };
      });
      const gateway = createGateway(client, true);
      const context = createContext(gateway);
      const page = createPage(context, { render: true });
      await waitForCronPage(() => expect(reads).toBe(1));
      gateway.emitRetiredEvent({ type: "event", event: "config.changed", payload: {} });
      await page.updateComplete;
      expect(reads).toBe(1);
      oldResult.resolve({ models: [{ id: "retired-model" }] });
      await waitForCronPage(() => expect(reads).toBe(2));
      expect(page.cronModelSuggestions).toEqual([]);

      if (change === "agent") {
        context.agentSelection.set("writer");
      } else if (change === "connection") {
        gateway.emitSnapshot({ phase: "reconnecting" });
        gateway.emitSnapshot({ phase: "connected" });
      } else if (change === "gateway") {
        page.context = createContext(createGateway(client, true));
        page.requestUpdate();
      } else if (change === "detach") {
        page.remove();
      } else {
        gateway.emitRetiredEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      }
      const expected = change === "detach" ? [] : ["current-model"];
      oldError.reject(new Error("Retired catalog error"));
      await Promise.allSettled([oldResult.promise, oldError.promise]);
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(expected));
      await page.updateComplete;
      expect(page.cronModelSuggestions).toEqual(expected);
      expect(page.textContent).not.toContain("Retired catalog error");
    },
  );

  it("refreshes model suggestions when team selection changes without changing scope", async () => {
    const lateMain = createDeferred<{ models: { id: string }[] }>();
    const writer = createDeferred<{ models: { id: string }[] }>();
    const fallback = createRequest();
    const modelRequests: unknown[] = [];
    let mainReads = 0;
    const client = createTestGatewayClient((method, params) => {
      if (method !== "models.list") {
        return fallback(method);
      }
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
        settings: {
          gatewayUrl: "",
          sidebarAgentsMode: "roster",
          sidebarPreTeamScope: undefined,
        },
        patch: () => undefined,
        subscribe: () => () => undefined,
      },
    );
    const page = createPage(
      { ...createContext(gateway, null, "main"), agentSelection },
      { render: true },
    );
    try {
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["main-model"]));
      const cron = page.cron;
      gateway.emitRetiredEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
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
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["writer-model"]));
      lateMain.resolve({ models: [{ id: "late-main-model" }] });
      await lateMain.promise;
      await page.updateComplete;
      expect(page.cronModelSuggestions).toEqual(["writer-model"]);
    } finally {
      page.remove();
      agentSelection.dispose();
      writer.resolve({ models: [] });
      lateMain.resolve({ models: [] });
    }
  });

  it("coalesces a cron event burst into one trailing refresh of the current page", async () => {
    const held = createDeferred();
    let released = false;
    const freshJob = createCronViewJob("fresh-job", {
      configRevision: "fresh-config",
      state: {},
    });
    const freshRun = {
      ts: 2,
      jobId: freshJob.id,
      action: "finished",
      status: "ok",
      summary: "Finished after the refresh started",
    };
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
      await page.updateComplete;
      for (let index = 0; index < 20; index += 1) {
        gateway.emitRetiredEvent({ event: "cron" } as never);
      }
      for (const method of ["cron.status", "cron.runs", "cron.list", "channels.status"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }

      released = true;
      held.resolve();
      await waitForCronPage(() => {
        expect(page.cron.cronStatus?.jobs).toBe(1);
        expect(page.cron.cronJobs).toEqual([freshJob]);
        expect(page.cron.cronRuns).toEqual([freshRun]);
      });
      for (const method of ["cron.status", "cron.runs", "cron.list"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(2);
      }
      expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
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
        : {
            entries: [{ ts: revision, jobId: "job", action: "finished", status: "ok" }],
            total: 1,
            hasMore: false,
          };
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
      await page.updateComplete;
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
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
            return {
              entries: [{ ts: 99, jobId: "retired-job", action: "finished", status: "ok" }],
              total: 1,
              hasMore: false,
            };
          }
        }
        return fallback(method);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const gateway = createGateway(client, true);
      const context = createContext(gateway);
      const page = createPage(context);
      try {
        await page.updateComplete;
        gateway.emitRetiredEvent({ event: "cron" } as never);
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
          page.requestUpdate();
        } else {
          page.remove();
        }
        await page.updateComplete;
        await waitForCronPage(() =>
          expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(
            change === "reconnect" || change === "gateway source" ? 2 : 1,
          ),
        );
        const count = request.mock.calls.length;
        held.resolve();
        // Let the retired read and its queued completion settle before checking dispatch.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        await page.updateComplete;
        expect(request).toHaveBeenCalledTimes(count);
        expect(page.cron.cronError).toBeNull();
        expect(page.cron.cronStatus?.jobs).not.toBe(99);
        expect(page.cron.cronJobs.some((job) => job.id === "retired-job")).toBe(false);
        expect(page.cron.cronRuns.some((run) => run.jobId === "retired-job")).toBe(false);
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
    expect(page.cron.cronStatus).toBeNull();
    gateway.emitSnapshot({ phase: "connected" });

    await waitForCronPage(() =>
      expect(page.cron.cronStatus).toMatchObject({ triggersEnabled: false }),
    );
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(2);
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.querySelector("fieldset.cron-editor")).not.toBeNull());

    const triggerToggle = Array.from(page.querySelectorAll("wa-switch.settings-toggle")).find(
      (toggle) => toggle.textContent?.includes("Condition trigger"),
    );
    expect(triggerToggle).toBeUndefined();
    expect(page.textContent).toContain("disabled by cron.triggers.enabled");
  });

  it("ignores a cron event callback retained by a replaced gateway source", async () => {
    const request = createRequest();
    const client = { request } as unknown as GatewayBrowserClient;
    const firstGateway = createGateway(client, true);
    const secondGateway = createGateway(client, true);
    const firstContext = createContext(firstGateway);
    const secondContext = createContext(secondGateway);
    const page = createPage(firstContext);
    await waitForCronPage(() => expect(request).toHaveBeenCalled());

    page.context = secondContext;
    page.requestUpdate();
    await page.updateComplete;
    await waitForCronPage(() => expect(page.cron.client).toBe(client));
    request.mockClear();
    vi.mocked(secondContext.channels.refresh).mockClear();

    firstGateway.emitRetiredEvent({ event: "cron" } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(secondContext.channels.refresh).not.toHaveBeenCalled();
  });
});

describe("automation route hydration", () => {
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
        // Warm reload mounts the route before either authoritative default arrives.
        await page.updateComplete;
        expect(agentSelection.state.scopeId).toBeNull();
        gateway.emitSnapshot({
          phase: "connected",
          assistantAgentId: changingCatalog ? "previous" : publication === "hello" ? "main" : null,
        });
        await page.updateComplete;
        if (changingCatalog) {
          await waitForCronPage(() =>
            expect(page.cronModelSuggestions).toEqual(["previous-model"]),
          );
        }
        if (edited) {
          lookup.resolve(job);
          await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
          const name = page.querySelector<HTMLInputElement>("#cron-name")!;
          name.value = "Unsaved name";
          name.dispatchEvent(new Event("input", { bubbles: true }));
          await page.updateComplete;
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
          expect(page.querySelector(".cron-detail-title")?.textContent ?? "").toContain(job.name);
          expect(page.querySelector("details.cron-advanced > summary")).not.toBeNull();
          expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
            edited ? "Unsaved name" : job.name,
          );
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
});

describe("selected automation runtime refresh", () => {
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
    const fallback = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.get") {
        expect(params).toEqual({ id: selected.id });
        reads += 1;
        return reads === 1 ? selected : reads === 2 ? pending.promise : trailing.promise;
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    page.routeSearch = `?job=${selected.id}`;
    try {
      await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
      const name = page.querySelector<HTMLInputElement>("#cron-name")!;
      name.value = "Unsaved automation";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
      const definition = page.cron.cronEditingJob;
      const draft = page.cron.cronForm;
      const previousHeader = page.querySelector(".cron-detail-meta")?.textContent;
      gateway.emitRetiredEvent({
        type: "event",
        event: "cron",
        payload: { jobId: selected.id, action: "finished" },
      });
      // An event during the exact read requires one trailing refresh.
      gateway.emitRetiredEvent({
        type: "event",
        event: "cron",
        payload: { jobId: selected.id, action: "finished" },
      });
      pending.resolve({
        ...selected,
        name: "Remote definition",
        configRevision: "remote-definition",
        state: { triggerEvalCount: 7, nextRunAtMs: Date.now() + 86_400_000 },
      });
      trailing.resolve({ ...selected, state: { triggerEvalCount: 9 } });
      await waitForCronPage(() => {
        expect(page.querySelector(".cron-detail-meta")?.textContent).not.toBe(previousHeader);
        expect(page.cron.cronEditingJob?.state?.triggerEvalCount).toBe(9);
      });
      expect(reads).toBe(3);
      expect(page.cron.cronJobs).toEqual([]);
      expect(page.cron.cronEditingJob).toBe(definition);
      expect(page.cron.cronEditingJob?.configRevision).toBe("saved-definition");
      expect(page.querySelector(".cron-detail-title")?.textContent).toContain("Saved automation");
      expect(page.cron.cronForm).toBe(draft);
      expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe("Unsaved automation");
      page
        .querySelector<HTMLElement>('[data-test-id="cron-detail-tab-history"]')!
        .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      await waitForCronPage(() =>
        expect(page.querySelector(".cron-condition-activity__metric dd")?.textContent).toBe("9"),
      );
    } finally {
      page.remove();
      pending.resolve(selected);
      trailing.resolve(selected);
    }
  });
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

describe("CronPage hidden refreshes", () => {
  it("defers a hidden mount and reconnect, then catches up once with the current scope", async () => {
    const visibility = controlVisibility("hidden");
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const context = createContext(gateway);
    const page = createPage(context);
    await page.updateComplete;
    gateway.emitSnapshot({ phase: "stopped" });
    context.agentSelection.setScope("writer");
    gateway.emitSnapshot({ phase: "connected" });
    for (let event = 0; event < 20; event += 1) {
      gateway.emitRetiredEvent({ event: "cron" } as never);
    }
    await settle();
    expect(request.mock.calls.filter(([method]) => refreshMethods.includes(method))).toEqual([]);
    expect(context.channels.refresh).not.toHaveBeenCalled();

    visibility("visible");
    globalThis.dispatchEvent(new Event("focus"));
    await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
    await settle();
    for (const method of refreshMethods) {
      expect(
        request.mock.calls.filter(([called]) => called === method),
        method,
      ).toHaveLength(1);
    }
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "writer" }),
    );
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
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const page = createPage(createContext(gateway));
      try {
        await page.updateComplete;
        const current = page.cron;
        current.cronJobsQuery = "keep my filter";
        current.cronCreateOpen = true;
        current.cronForm.name = "Unsaved automation";
        for (let event = 0; event < 20; event += 1) {
          gateway.emitRetiredEvent({ event: "cron" } as never);
        }
        visibility("hidden");
        current.cronRunsQuery = "keep my history filter";
        hold = false;
        if (finishHidden) {
          held.resolve();
          await settle();
        }
        for (const method of refreshMethods) {
          expect(
            request.mock.calls.filter(([called]) => called === method),
            method,
          ).toHaveLength(1);
        }
        visibility("visible");
        globalThis.dispatchEvent(new Event("focus"));
        held.resolve();
        await waitForCronPage(() => expect(page.cron.cronLoading).toBe(false));
        await settle();
        for (const method of refreshMethods) {
          expect(
            request.mock.calls.filter(([called]) => called === method),
            method,
          ).toHaveLength(2);
        }
        expect(page.cron).toBe(current);
        expect(current.cronCreateOpen).toBe(true);
        expect(current.cronForm.name).toBe("Unsaved automation");
        expect(
          request.mock.calls.findLast(([method]) => method === "cron.list")?.[1],
        ).toMatchObject({ query: "keep my filter" });
        expect(
          request.mock.calls.findLast(([method]) => method === "cron.runs")?.[1],
        ).toMatchObject({ query: "keep my history filter" });
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
    const oldGateway = createGateway(
      { request: oldRequest } as unknown as GatewayBrowserClient,
      true,
    );
    const page = createPage(createContext(oldGateway));
    try {
      await page.updateComplete;
      oldGateway.emitRetiredEvent({ event: "cron" } as never);
      visibility("hidden");
      const request = createRequest();
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      page.context = createContext(gateway, "writer");
      page.requestUpdate();
      await page.updateComplete;
      held.resolve();
      await settle();
      expect(request).not.toHaveBeenCalled();
      for (const method of refreshMethods) {
        expect(
          oldRequest.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
      oldRequest.mockClear();
      visibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      oldGateway.emitRetiredEvent({ event: "cron" } as never);
      await settle();
      for (const method of refreshMethods) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
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
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.add") {
        await saved.promise;
        return { id: "created-job" };
      }
      if (method === "cron.run") {
        return { ok: true, enqueued: true, runId: "synthetic-run" };
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() => expect(page.cron.cronStatus).not.toBeNull());
      (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
      await page.updateComplete;
      for (const [selector, value] of [
        ["#cron-name", "Synthetic task"],
        ["#cron-payload-text", "Synthetic prompt"],
      ] as const) {
        const input = page.querySelector(selector) as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await page.updateComplete;
      (page.querySelector('[data-test-id="cron-submit-run"]') as HTMLButtonElement).click();
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
      expect(page.cron.cronError).toContain("Run queued. Run ID: synthetic-run");
      expect(page.cron.cronCreateOpen).toBe(false);
      visibility("visible");
      await settle();
      for (const method of refreshMethods) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(1);
      }
    } finally {
      saved.resolve();
      page.remove();
    }
  });
});
