/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  CronJob,
  CronJobsListResult,
  ModelCatalogEntry,
  SkillStatusReport,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { agentFileValues } from "./agent-file-state.test-helpers.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  emitCatalogChanged,
  gateway,
  pageContext,
  emitGatewaySnapshot,
  settingsSelection,
  snapshot,
  createAgentsPage,
} from "./agents-page.test-support.ts";

const files = (agentId: string, workspace: string) => ({ agentId, workspace, files: [] });

function mountPage(
  client: GatewayBrowserClient | null,
  panel: AgentsPanel = "overview",
  overrides: Partial<ApplicationContext> = {},
) {
  const currentGateway = overrides.gateway ?? gateway(snapshot(client));
  const agents = agentsCapability(async () => files("main", "unused"));
  agents.state.agentsList = {
    ...agentsList,
    agents: [
      ...agentsList.agents,
      ...["worker", "other", "research"].map((id) => ({ id, name: id })),
    ],
  };
  const context = { ...pageContext(currentGateway, agents), ...overrides };
  const page = createAgentsPage(context, {
    ...agentsRouteData(
      currentGateway,
      context.agents.state.agentsList,
      "main",
      context.settingsAgentSelection,
    ),
    panel,
  });
  return { page, context, currentGateway };
}

function refreshPanel(page: ReturnType<typeof createAgentsPage>) {
  if (page.read().readData().agentsPanel === "cron") {
    page.read().cron.onRefresh();
  } else {
    page.read().overview.onModelCatalogOpen?.();
  }
}

function cronJob(id: string, agentId?: string): CronJob {
  return {
    id,
    ...(agentId ? { agentId } : {}),
    name: `Scheduled job ${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  } as CronJob;
}

function cronListResponse(
  jobs: CronJob[],
  options: { total?: number; offset?: number; limit?: number } = {},
): CronJobsListResult {
  const total = options.total ?? jobs.length;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const nextOffset = offset + jobs.length;
  const hasMore = nextOffset < total;
  return {
    jobs,
    snapshotRevision: "agents-page-cron-fixture",
    total,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

describe("AgentsPage gateway lifecycle", () => {
  it("retires issued skill reads across a same-client reconnect", async () => {
    const stale = deferred<SkillStatusReport>();
    const current: SkillStatusReport = {
      workspaceDir: "/workspace/current",
      managedSkillsDir: "/skills/current",
      skills: [],
    };
    let skillReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "skills.status") {
        return ++skillReads === 1 ? stale.promise : current;
      }
      return {};
    });
    const client = createTestGatewayClient(request);
    const { page, currentGateway } = mountPage(client, "skills");
    const issued = page.read().readData().agentSkillsRead;
    expect(issued?.agentId).toBe("main");
    page.read().agentSkills.onRefresh();
    expect(skillReads).toBe(1);

    emitGatewaySnapshot(currentGateway, snapshot(client, false));
    emitGatewaySnapshot(currentGateway, snapshot(client));
    await waitForFast(() => expect(page.read().readData().agentSkillsReport).toBe(current));
    expect(skillReads).toBe(2);
    stale.resolve({ ...current, workspaceDir: "/workspace/retired" });
    await issued?.result;
    expect(page.read().readData().agentSkillsReport).toBe(current);
    expect(page.read().readData().agentSkillsRead).not.toBe(issued);
  });

  it("does not stage a default-agent change after a same-client reconnect", async () => {
    const loading = deferred();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const stageDefaultAgent = vi.fn(() => true);
    const save = vi.fn(async () => true);
    const context = pageContext(currentGateway, agents);
    const configured = {
      ...context,
      runtimeConfig: {
        state: { configFormDirty: false, configSnapshot: { config: {} } },
        ensureLoaded: vi.fn(() => loading.promise),
        stageDefaultAgent,
        save,
        subscribe: vi.fn(() => () => undefined),
      },
    } as unknown as ApplicationContext;
    const { page } = mountPage(client, "overview", configured);

    const settingDefault = page.read().onSetDefault("research");
    expect(configured.runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    emitGatewaySnapshot(currentGateway, snapshot(client, false));
    emitGatewaySnapshot(currentGateway, snapshot(client));
    loading.resolve();
    await settingDefault;

    expect(stageDefaultAgent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("invalidates a queued agent skills clear across a same-client reconnect", async () => {
    const result = deferred<boolean>();
    const client = createTestGatewayClient(vi.fn(async () => ({ skills: [] })));
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const patch = vi.fn(
      (_options: Parameters<ApplicationContext["runtimeConfig"]["patch"]>[0]) => result.promise,
    );
    const runtimeConfig = {
      state: {},
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"];
    const { page } = mountPage(client, "skills", {
      ...pageContext(currentGateway, agents),
      runtimeConfig,
    });

    const completion = page.read().agentSkills.onClear("main");
    let presentationSettled = false;
    void completion?.then(() => {
      presentationSettled = true;
    });
    await waitForFast(() => expect(patch).toHaveBeenCalledOnce());
    const canDispatch = vi.mocked(patch).mock.calls[0]?.[0]?.canDispatch;
    expect(canDispatch?.()).toBe(true);

    emitGatewaySnapshot(currentGateway, snapshot(client, false));
    emitGatewaySnapshot(currentGateway, snapshot(client));

    expect(canDispatch?.()).toBe(false);
    await waitForFast(() => expect(presentationSettled).toBe(true));
    result.reject(new Error("Retired reset failed."));
    await result.promise.catch(() => undefined);
    await expect(completion).resolves.toBeUndefined();
  });

  it("returns reset outcomes while retaining an admitted pending skill read", async () => {
    const pending = deferred<SkillStatusReport>();
    const client = createTestGatewayClient(vi.fn(() => pending.promise));
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "unused"));
    const runtimeConfig = {
      state: { lastError: "Gateway rejected the patch." },
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"];
    const { page } = mountPage(client, "skills", {
      ...pageContext(currentGateway, agents),
      runtimeConfig,
    });

    await expect(page.read().agentSkills.onClear("main")).rejects.toThrow(
      "Gateway rejected the patch.",
    );
    const issued = page.read().readData().agentSkillsRead;
    await expect(page.read().agentSkills.onClear("main")).resolves.toBeUndefined();
    expect(page.read().readData().agentSkillsRead).toBe(issued);
    pending.resolve({
      workspaceDir: "/workspace/synthetic",
      managedSkillsDir: "/skills",
      skills: [],
    });
    await issued?.result;
  });

  it("does not refresh the agent roster after a rejected config save", async () => {
    const client = createTestGatewayClient(vi.fn(async () => ({ models: [] })));
    const agents = agentsCapability(async () => files("main", "unused"));
    const refreshList = vi.fn(async () => agentsList);
    agents.refreshList = refreshList;
    const save = vi.fn(async () => false);
    const context = pageContext(gateway(snapshot(client)), agents);
    Object.assign(context.runtimeConfig, { save });
    const { page } = mountPage(client, "overview", context);
    context.runtimeConfig.state.lastError = "Synthetic config save refused";
    await page.read().onConfigSave();
    expect(save).toHaveBeenCalledOnce();
    expect(refreshList).not.toHaveBeenCalled();
    expect(page.read().config.lastError).toBe("Synthetic config save refused");
  });

  it("keeps config save completion pending through the agent roster refresh", async () => {
    const saved = deferred<boolean>();
    const roster = deferred<typeof agentsList>();
    const client = createTestGatewayClient(vi.fn(async () => ({ models: [] })));
    const agents = agentsCapability(async () => files("main", "unused"));
    agents.refreshList = vi.fn(() => roster.promise);
    const context = pageContext(gateway(snapshot(client)), agents);
    Object.assign(context.runtimeConfig, { save: () => saved.promise });
    const { page } = mountPage(client, "overview", context);
    let completed = false;
    const completion = page
      .read()
      .onConfigSave()
      .then(() => {
        completed = true;
      });
    saved.resolve(true);
    await waitForFast(() => expect(agents.refreshList).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    roster.resolve(agentsList);
    await completion;
    expect(completed).toBe(true);
  });

  it("loads the selected agent's configured model catalog once for the overview model picker", async () => {
    const models = [
      {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        alias: "opus",
        provider: "anthropic",
      },
    ];
    const request = vi.fn(async () => ({ models }));
    const { page } = mountPage({ request } as unknown as GatewayBrowserClient, "overview");

    refreshPanel(page);
    refreshPanel(page);

    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(models));
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("models.list", { view: "configured", agentId: "main" });
  });

  it("reads separate configured model catalogs when switching default and worker agents", async () => {
    const defaultModels = [
      { id: "default-model", name: "Default account model", provider: "openai" },
    ];
    const workerModels = [
      { id: "worker-model", name: "Worker private model", provider: "anthropic" },
    ];
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      models: params?.agentId === "worker" ? workerModels : defaultModels,
    }));
    const { page, context } = mountPage({ request } as unknown as GatewayBrowserClient, "overview");

    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(defaultModels));

    context.settingsAgentSelection.set("worker");
    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(workerModels));

    context.settingsAgentSelection.set("main");
    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(defaultModels));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "models.list", {
      view: "configured",
      agentId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      view: "configured",
      agentId: "worker",
    });
  });

  it.each([false, true])(
    "keeps returned choices and reports catalog failure until recovery (retained rows: %s)",
    async (hasRows) => {
      const models = hasRows ? [{ id: "current", name: "Current model", provider: "fixture" }] : [];
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          models: [{ id: "old", name: "Old model", provider: "fixture" }],
        })
        .mockResolvedValueOnce({ models, refreshFailed: true })
        .mockResolvedValueOnce({ models: [] });
      const { page, currentGateway } = mountPage(createTestGatewayClient(request));

      refreshPanel(page);
      await waitForFast(() => expect(page.read().overview.modelCatalog[0]?.id).toBe("old"));
      emitCatalogChanged(currentGateway);
      await waitForFast(async () =>
        expect(page.read().readData().chatModelCatalogRead).rejects.toThrow(
          hasRows
            ? "Some models could not be refreshed. Open Models to try again."
            : "Models unavailable",
        ),
      );
      expect(page.read().overview.modelCatalog).toEqual(models);

      page.read().overview.onModelCatalogOpen?.();
      await waitForFast(async () =>
        expect(page.read().readData().chatModelCatalogRead).resolves.toBeUndefined(),
      );
      expect(page.read().overview.modelCatalog).toEqual([]);
      expect(request.mock.calls.map(([method, params]) => ({ method, params }))).toEqual(
        Array.from({ length: 3 }, () => ({
          method: "models.list",
          params: { agentId: "main", view: "configured" },
        })),
      );
    },
  );

  it("rejects a stale default-agent catalog after switching to a worker agent", async () => {
    const defaultModels = [
      { id: "default-model", name: "Default account model", provider: "openai" },
    ];
    const workerModels = [
      { id: "worker-model", name: "Worker private model", provider: "anthropic" },
    ];
    const defaultResult = deferred<{ models: ModelCatalogEntry[] }>();
    const request = vi.fn((_method: string, params?: { agentId?: string }) =>
      params?.agentId === "worker"
        ? Promise.resolve({ models: workerModels })
        : defaultResult.promise,
    );
    const { page, context } = mountPage({ request } as unknown as GatewayBrowserClient, "overview");

    refreshPanel(page);
    context.settingsAgentSelection.set("worker");
    refreshPanel(page);

    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(workerModels));
    defaultResult.resolve({ models: defaultModels });
    await defaultResult.promise;
    await Promise.resolve();

    expect(page.read().overview.modelCatalog).toEqual(workerModels);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      view: "configured",
      agentId: "worker",
    });
  });

  it("keeps picker opens cached and reloads after a catalog publication", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels });
    const { page, currentGateway } = mountPage(
      { request } as unknown as GatewayBrowserClient,
      "overview",
    );

    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(oldModels));

    page.read().overview.onModelCatalogOpen?.();
    expect(request).toHaveBeenCalledTimes(1);

    page.read().overview.onModelCatalogOpen?.();
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(oldModels));
    expect(request).toHaveBeenCalledTimes(1);

    emitCatalogChanged(currentGateway);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["client", "reconnect", "gateway source", "publication"] as const)(
    "rejects an old model read after a newer %s",
    async (replacement) => {
      const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
      const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
      const oldResult = deferred<{ models: ModelCatalogEntry[] }>();
      const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
      const nextClient = new GatewayBrowserClient({ url: "ws://gateway.test" });
      const oldRequest = vi
        .spyOn(client, "request")
        .mockReturnValueOnce(oldResult.promise)
        .mockResolvedValue({ models: nextModels });
      const nextRequest = vi.spyOn(nextClient, "request").mockResolvedValue({ models: nextModels });
      const initial = mountPage(client);
      let page = initial.page;
      const currentGateway = initial.currentGateway;

      refreshPanel(page);
      if (replacement === "publication") {
        emitCatalogChanged(currentGateway);
      } else {
        if (replacement === "reconnect") {
          emitGatewaySnapshot(currentGateway, snapshot(client, false));
        }
        if (replacement === "gateway source") {
          page.dispose();
          ({ page } = mountPage(client));
        } else {
          emitGatewaySnapshot(
            currentGateway,
            snapshot(replacement === "client" ? nextClient : client),
          );
        }
        refreshPanel(page);
      }

      await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(nextModels));
      oldResult.resolve({ models: oldModels });
      await oldResult.promise;
      await Promise.resolve();

      expect(page.read().overview.modelCatalog).toEqual(nextModels);
      expect(oldRequest.mock.calls.length + nextRequest.mock.calls.length).toBe(2);
    },
  );

  it("refreshes a settled model catalog after a same-client reconnect", async () => {
    const oldModels = [{ id: "old", name: "Old Model", alias: "opus", provider: "anthropic" }];
    const nextModels = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: oldModels })
      .mockResolvedValueOnce({ models: nextModels });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, currentGateway } = mountPage(client, "overview");

    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(oldModels));

    emitGatewaySnapshot(currentGateway, snapshot(client, false));
    expect(page.read().overview.modelCatalog).toEqual([]);
    emitCatalogChanged(currentGateway);
    emitGatewaySnapshot(currentGateway, snapshot(client));
    refreshPanel(page);

    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(nextModels));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      view: "configured",
      agentId: "main",
    });
  });

  it("surfaces a rejected agent-scoped metadata RPC and retries without marking an empty catalog loaded", async () => {
    const models = [{ id: "new", name: "Opus 4.8", alias: "opus", provider: "anthropic" }];
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("model catalog unavailable"))
      .mockResolvedValueOnce({ models });
    const { page } = mountPage({ request } as unknown as GatewayBrowserClient, "overview");

    refreshPanel(page);
    await waitForFast(async () => {
      await expect(page.read().readData().chatModelCatalogRead).rejects.toThrow(
        "model catalog unavailable",
      );
    });
    expect(page.read().overview.modelCatalog).toEqual([]);

    refreshPanel(page);
    await waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(models));

    await expect(page.read().readData().chatModelCatalogRead).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      view: "configured",
      agentId: "main",
    });
  });

  it("does not refresh the agent cron panel without operator read access", async () => {
    const request = vi.fn(async () => ({}));
    const client = createTestGatewayClient(request);
    const current = {
      ...snapshot(client),
      hello: gatewayHelloForMethods(["cron.list", "cron.status"], ["operator.sessions.read"]),
    };
    const { page } = mountPage(client, "cron", { gateway: gateway(current) });
    page.read().cron.onRefresh();
    expect(request).not.toHaveBeenCalled();
  });

  it("requests the selected agent's implicit default cron job before the first 50 unrelated jobs", async () => {
    const unrelatedJobs = Array.from({ length: 50 }, (_, index) =>
      cronJob(`other-${index}`, "other"),
    );
    const globalNextWakeAtMs = Date.now() + 60_000;
    const scopedNextWakeAtMs = globalNextWakeAtMs + 3_600_000;
    const implicitDefaultJob = {
      ...cronJob("default-job"),
      state: { nextRunAtMs: scopedNextWakeAtMs },
    };
    const request = vi.fn(async (method: string, params?: { agentId?: string; limit?: number }) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 51, nextWakeAtMs: globalNextWakeAtMs };
      }
      if (method === "cron.list") {
        const scoped = params?.agentId === "main";
        return cronListResponse(scoped ? [implicitDefaultJob] : unrelatedJobs, {
          total: scoped ? 1 : 51,
          limit: params?.limit,
        });
      }
      throw new Error(`Unexpected gateway method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page } = mountPage(client, "cron");

    refreshPanel(page);

    await waitForFast(() => {
      expect(page.read().readData().cron.cronJobs).toEqual([implicitDefaultJob]);
      expect(page.read().readData().cron.cronScopedTotal).toBe(1);
      expect(page.read().readData().cron.cronScopedNextWakeAtMs).toBe(scopedNextWakeAtMs);
    });
    expect(page.read().readData().cron.cronStatus).toEqual({
      enabled: true,
      jobs: 51,
      nextWakeAtMs: globalNextWakeAtMs,
    });
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 50, offset: 0 }),
    );
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 1, enabled: "enabled" }),
    );
  });

  it("loads the selected agent's remaining cron jobs after preserving the first-page total", async () => {
    const jobs = Array.from({ length: 50 }, (_, index) => cronJob(`main-${index}`, "main"));
    const lastJob = cronJob("main-50", "main");
    const request = vi.fn(
      async (method: string, params?: { agentId?: string; limit?: number; offset?: number }) => {
        if (method === "cron.status") {
          return { enabled: true, jobs: 80, nextWakeAtMs: null };
        }
        if (params?.limit === 1) {
          return cronListResponse([jobs[0]!], { total: 51, limit: 1 });
        }
        if (params?.offset === 50) {
          return cronListResponse([lastJob], { total: 51, offset: 50 });
        }
        return cronListResponse(jobs, { total: 51 });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { page } = mountPage(client, "cron");

    refreshPanel(page);

    await waitForFast(() => {
      expect(page.read().readData().cron.cronJobs).toHaveLength(50);
      expect(page.read().readData().cron.cronJobsTotal).toBe(51);
      expect(page.read().readData().cron.cronScopedTotal).toBe(51);
    });
    expect(page.read().readData().cron.cronJobsHasMore).toBe(true);

    page.read().cron.onLoadMore();
    await waitForFast(() => expect(page.read().readData().cron.cronJobs).toHaveLength(51));

    expect(page.read().readData().cron.cronJobs).toHaveLength(51);
    expect(page.read().readData().cron.cronJobs.at(-1)).toEqual(lastJob);
    expect(page.read().readData().cron.cronJobsTotal).toBe(51);
    expect(page.read().readData().cron.cronScopedTotal).toBe(51);
    expect(page.read().readData().cron.cronJobsHasMore).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "main", limit: 50, offset: 50 }),
    );
  });

  it("reloads cron jobs when the selected agent changes", async () => {
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      if (method === "cron.status") {
        return { enabled: true, jobs: 2, nextWakeAtMs: null };
      }
      return cronListResponse([cronJob(`${params?.agentId}-job`, params?.agentId)]);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, context } = mountPage(client, "cron");

    refreshPanel(page);
    await waitForFast(() => expect(page.read().readData().cron.cronJobs[0]?.id).toBe("main-job"));

    context.settingsAgentSelection.set("other");
    refreshPanel(page);
    expect(page.read().readData().cron.cronJobs).toEqual([]);

    await waitForFast(() => expect(page.read().readData().cron.cronJobs[0]?.id).toBe("other-job"));
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "other" }),
    );
  });

  it("keeps an in-flight scoped cron request attached to a same-client gateway snapshot", async () => {
    const job = cronJob("same-client-job", "main");
    const pendingJobs = deferred<CronJobsListResult>();
    const request = vi.fn((method: string, params?: { limit?: number }) => {
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, jobs: 1, nextWakeAtMs: null });
      }
      if (params?.limit === 50) {
        return pendingJobs.promise;
      }
      return Promise.resolve(cronListResponse([job]));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, currentGateway } = mountPage(client, "cron");

    refreshPanel(page);
    await waitForFast(() => expect(page.read().readData().cron.cronLoading).toBe(true));
    emitGatewaySnapshot(currentGateway, snapshot(client));
    expect(page.read().readData().cron.cronLoading).toBe(true);
    expect(
      request.mock.calls.filter(
        ([method, params]) => method === "cron.list" && params?.limit === 50,
      ),
    ).toHaveLength(1);

    pendingJobs.resolve(cronListResponse([job]));
    await waitForFast(() => {
      expect(page.read().readData().cron.cronJobs).toEqual([job]);
      expect(page.read().readData().cron.cronLoading).toBe(false);
    });
  });

  it("immediately publishes cron loading and ignores a second refresh while the first is pending", async () => {
    const job = cronJob("double-refresh-job", "main");
    const pendingJobs = deferred<CronJobsListResult>();
    const request = vi.fn((method: string, params?: { limit?: number }) => {
      if (method === "cron.status") {
        return Promise.resolve({ enabled: true, jobs: 1, nextWakeAtMs: null });
      }
      if (params?.limit === 50) {
        return pendingJobs.promise;
      }
      return Promise.resolve(cronListResponse([job]));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page } = mountPage(client, "cron");
    expect(page.read().readData().cron.cronLoading).toBe(true);
    page.read().cron.onRefresh();
    expect(
      request.mock.calls.filter(
        ([method, params]) => method === "cron.list" && params?.limit === 50,
      ),
    ).toHaveLength(1);

    pendingJobs.resolve(cronListResponse([job]));
    await waitForFast(() => expect(page.read().readData().cron.cronLoading).toBe(false));

    expect(page.read().readData().cron.cronLoading).toBe(false);
    expect(page.read().readData().cron.cronJobs).toEqual([job]);
  });

  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client, false));
    const selection = settingsSelection(agentsList);
    const agents = agentsCapability(async () => files("main", "unused"));
    agents.state.agentsList = null;
    const route = agentsRouteData(currentGateway, agentsList, "main", selection);
    const context = { ...pageContext(currentGateway, agents), settingsAgentSelection: selection };
    const page = createAgentsPage(context, route);
    expect(page.read().readData().agentsList).toBe(agentsList);
    expect(page.read().selectedAgentId).toBe("main");

    page.dispose();
    const replacement = createAgentsPage(
      {
        ...context,
        gateway: gateway(snapshot(client, false)),
        settingsAgentSelection: settingsSelection(null, null),
      },
      route,
    );
    expect(replacement.read().readData().agentsList).toBeNull();
    expect(replacement.read().selectedAgentId).toBeNull();
  });

  it("rejects preloaded data after a same-client gateway source replacement", async () => {
    const client = {} as GatewayBrowserClient;
    const preloadedSnapshot = snapshot(client);
    const preloadedGateway = gateway(preloadedSnapshot);
    const currentGateway = gateway(preloadedSnapshot);
    const ensureList = vi.fn(async () => null);
    const agents = agentsCapability(async () => files("main", "unused"));
    agents.state.agentsList = null;
    agents.ensureList = ensureList;
    const context = pageContext(currentGateway, agents);
    const page = createAgentsPage(context, agentsRouteData(preloadedGateway));
    await Promise.resolve();
    expect(page.read().readData().agentsList).toBeNull();
    expect(ensureList).toHaveBeenCalledOnce();
  });

  it("does not let an old-client file load overwrite a replacement load", async () => {
    const first = deferred<AgentsFilesListResult>();
    const second = deferred<AgentsFilesListResult>();
    let fileReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "agents.list") {
        return agentsList;
      }
      if (method === "agents.files.list") {
        return ++fileReads === 1 ? first.promise : second.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const oldClient = createTestGatewayClient(request);
    const nextClient = createTestGatewayClient(request);
    const currentGateway = gateway(snapshot(oldClient));
    const agents = createAgentCapability(currentGateway);
    await agents.ensureList();
    const { page } = mountPage(oldClient, "files", { gateway: currentGateway, agents });
    try {
      emitGatewaySnapshot(currentGateway, snapshot(nextClient));
      await waitForFast(() => expect(fileReads).toBe(2));

      first.resolve(files("main", "old"));
      await first.promise;
      await Promise.resolve();
      expect(page.read().readData().agentFilesList).toBeNull();
      second.resolve(files("main", "new"));
      await waitForFast(() => expect(page.read().readData().agentFilesList?.workspace).toBe("new"));
    } finally {
      page.dispose();
      agents.dispose();
    }
  });

  it("selects and loads AGENTS.md when the file list opens", async () => {
    const fileList: AgentsFilesListResult = {
      agentId: "main",
      workspace: "/synthetic/workspace",
      files: [
        { name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing: false },
        { name: "SOUL.md", path: "/synthetic/workspace/SOUL.md", missing: false },
      ],
    };
    const request = vi.fn(async () => ({
      file: { ...fileList.files[0], content: "# Instructions" },
    }));
    const { page } = mountPage(createTestGatewayClient(request), "files", {
      agents: agentsCapability(async () => fileList),
    });
    await waitForFast(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("# Instructions"),
    );
    expect(page.read().readData().agentFileActive).toBe("AGENTS.md");
    expect(request).toHaveBeenCalledWith("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
  });

  it("retries an in-flight panel load after a same-client disconnect", async () => {
    const first = deferred<AgentsFilesListResult>();
    const second = deferred<AgentsFilesListResult>();
    const cached = { name: "cached.md", path: "/synthetic/cached.md", missing: false };
    let fileReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "agents.list") {
        return agentsList;
      }
      if (method === "agents.files.list") {
        return ++fileReads === 1 ? first.promise : second.promise;
      }
      if (method === "agents.files.get") {
        return { file: { ...cached, content: "keep" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const currentGateway = gateway(snapshot(client));
    const agents = createAgentCapability(currentGateway);
    await agents.ensureList();
    const { page } = mountPage(client, "files", { gateway: currentGateway, agents });
    try {
      page.read().agentFiles.onSelectFile("cached.md");
      await waitForFast(() =>
        expect(agentFileValues(page.read().readData(), "content")).toEqual({ "cached.md": "keep" }),
      );
      emitGatewaySnapshot(currentGateway, snapshot(client, false));
      expect(agentFileValues(page.read().readData(), "content")).toEqual({ "cached.md": "keep" });
      emitGatewaySnapshot(currentGateway, snapshot(client));
      await waitForFast(() => expect(fileReads).toBe(2));

      first.resolve(files("main", "old"));
      await first.promise;
      await Promise.resolve();
      expect(page.read().readData().agentFilesList).toBeNull();
      second.resolve(files("main", "new"));
      await waitForFast(() => expect(page.read().readData().agentFilesList?.workspace).toBe("new"));
    } finally {
      page.dispose();
      agents.dispose();
    }
  });

  it("rejects a file result from a replaced agents capability", async () => {
    const oldFiles = deferred<AgentsFilesListResult>();
    const nextFiles = deferred<AgentsFilesListResult>();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const context = pageContext(
      currentGateway,
      agentsCapability(() => oldFiles.promise),
    );
    const page = createAgentsPage(context, agentsRouteData(currentGateway));
    page.dispose();
    const replacement = createAgentsPage(
      { ...context, agents: agentsCapability(() => nextFiles.promise) },
      agentsRouteData(currentGateway),
    );
    oldFiles.resolve(files("main", "old"));
    await oldFiles.promise;
    await Promise.resolve();
    expect(replacement.read().readData().agentFilesList).toBeNull();
    nextFiles.resolve(files("main", "new"));
    await waitForFast(() =>
      expect(replacement.read().readData().agentFilesList?.workspace).toBe("new"),
    );
  });

  it("shows only replacement identities when the old capability settles", async () => {
    const oldEnsure = deferred();
    const nextEnsure = deferred();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const identity = (
      pending: Promise<void>,
      name: string,
    ): ApplicationContext["agentIdentity"] => {
      const entries: Array<{ agentId: string; name: string }> = [];
      return {
        get: () => entries[0] ?? null,
        entries: () => entries,
        invalidate: () => {},
        ensure: vi.fn(async () => {
          await pending;
          entries.push({ agentId: "main", name });
        }),
        subscribe: () => () => {},
      };
    };
    const oldIdentity = identity(oldEnsure.promise, "Old identity");
    const context = pageContext(
      currentGateway,
      agentsCapability(async () => files("main", "unused")),
      { agentIdentity: oldIdentity },
    );
    const page = createAgentsPage(context);
    page.dispose();
    const nextIdentity = identity(nextEnsure.promise, "New identity");
    const replacement = createAgentsPage({ ...context, agentIdentity: nextIdentity });
    expect(replacement.read().agentIdentityById).toEqual({});
    oldEnsure.resolve();
    await oldEnsure.promise;
    await Promise.resolve();
    expect(replacement.read().agentIdentityById).toEqual({});
    nextEnsure.resolve();
    await waitForFast(() =>
      expect(replacement.read().agentIdentityById).toEqual({
        main: { agentId: "main", name: "New identity" },
      }),
    );
  });
});
