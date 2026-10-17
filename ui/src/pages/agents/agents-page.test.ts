/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  CronJob,
  CronJobsListResult,
  ModelCatalogEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
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
const emptyAgents = () => agentsCapability(async () => files("main", "unused"));
const models = (id: string) => [{ id, name: `${id} model`, provider: "fixture" }];
const oldModels = [{ ...models("old")[0]!, alias: "opus" }];
const nextModels = models("new");
const defaultModels = models("default");
const workerModels = models("worker");
type Page = ReturnType<typeof createAgentsPage>;

function expectModels(page: Page, expected: ModelCatalogEntry[]) {
  return waitForFast(() => expect(page.read().overview.modelCatalog).toEqual(expected));
}

async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  pending.resolve(value);
  await pending.promise;
  await Promise.resolve();
}

function reconnect(currentGateway: ApplicationContext["gateway"], client: GatewayBrowserClient) {
  emitGatewaySnapshot(currentGateway, snapshot(client, false));
  emitGatewaySnapshot(currentGateway, snapshot(client));
}

function skillsConfig(lastError?: string) {
  const patch = vi.fn(
    async (_options: Parameters<ApplicationContext["runtimeConfig"]["patch"]>[0]) => false,
  );
  const runtimeConfig = {
    state: { lastError },
    agentEntry: vi.fn(() => ({
      path: ["agents", "entries", "main"],
      entry: { skills: ["coding-agent"] },
    })),
    patch,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["runtimeConfig"];
  return { patch, runtimeConfig };
}

function toolsRequest(effective: () => Promise<ToolsEffectiveResult> | ToolsEffectiveResult) {
  return vi.fn(async (method: string) =>
    method === "tools.effective" ? effective() : { agentId: "main", profiles: [], groups: [] },
  );
}

function mountPage(
  client: GatewayBrowserClient | null,
  panel: AgentsPanel = "overview",
  overrides: Partial<ApplicationContext> = {},
) {
  const currentGateway = overrides.gateway ?? gateway(snapshot(client));
  const agents = emptyAgents();
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
  if (page.read().activePanel === "cron") {
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

function pendingCronRequest(job: CronJob, pendingJobs: Promise<CronJobsListResult>) {
  return vi.fn((method: string, params?: { limit?: number }) => {
    if (method === "cron.status") {
      return Promise.resolve({ enabled: true, jobs: 1, nextWakeAtMs: null });
    }
    return params?.limit === 50 ? pendingJobs : Promise.resolve(cronListResponse([job]));
  });
}

describe("AgentsPage gateway lifecycle", () => {
  it("retires visible-session effective tools across a same-client reconnect", async () => {
    const staleResult = deferred<ToolsEffectiveResult>();
    let effectiveReads = 0;
    const request = toolsRequest(() =>
      ++effectiveReads === 1
        ? staleResult.promise
        : { agentId: "main", profile: "current-connection", groups: [] },
    );
    const client = createTestGatewayClient(request);
    const { page, currentGateway } = mountPage(client, "tools");
    expect(page.read().tools.toolsEffectiveLoading).toBe(true);
    reconnect(currentGateway, client);
    await waitForFast(() =>
      expect(page.read().tools.toolsEffectiveResult?.profile).toBe("current-connection"),
    );
    await settle(staleResult, { profile: "retired-connection" } as ToolsEffectiveResult);
    expect(page.read().tools.toolsEffectiveResult?.profile).toBe("current-connection");
    expect(page.read().tools).toMatchObject({
      toolsEffectiveError: null,
      toolsEffectiveLoading: false,
    });
  });

  it("does not stage a default-agent change after a same-client reconnect", async () => {
    const loading = deferred();
    const client = {} as GatewayBrowserClient;
    const stageDefaultAgent = vi.fn(() => true);
    const save = vi.fn(async () => true);
    const ensureLoaded = vi.fn(() => loading.promise);
    const runtimeConfig = {
      state: { configFormDirty: false, configSnapshot: { config: {} } },
      ensureLoaded,
      stageDefaultAgent,
      save,
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"];
    const { page, currentGateway } = mountPage(client, "overview", { runtimeConfig });

    page.read().onSetDefault("research");
    expect(ensureLoaded).toHaveBeenCalledOnce();
    reconnect(currentGateway, client);
    await settle(loading, undefined);

    expect(stageDefaultAgent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("invalidates a queued agent skills clear across a same-client reconnect", async () => {
    const client = createTestGatewayClient(vi.fn(async () => ({ skills: [] })));
    const { patch, runtimeConfig } = skillsConfig();
    const { page, currentGateway } = mountPage(client, "skills", { runtimeConfig });

    page.read().agentSkills.onClear("main");
    await waitForFast(() => expect(patch).toHaveBeenCalledOnce());
    const canDispatch = vi.mocked(patch).mock.calls[0]?.[0]?.canDispatch;
    expect(canDispatch?.()).toBe(true);

    reconnect(currentGateway, client);

    expect(canDispatch?.()).toBe(false);
  });

  it("surfaces a rejected agent skills clear in the panel", async () => {
    const client = createTestGatewayClient(vi.fn(async () => ({ skills: [] })));
    const { runtimeConfig } = skillsConfig("Gateway rejected the patch.");
    const { page } = mountPage(client, "skills", { runtimeConfig });

    page.read().agentSkills.onClear("main");

    await waitForFast(() =>
      expect(page.read().agentSkills.error).toBe("Gateway rejected the patch."),
    );
  });

  it("does not refresh the agent roster after a rejected config save", async () => {
    const client = createTestGatewayClient(vi.fn(async () => ({ models: [] })));
    const agents = emptyAgents();
    const refreshList = vi.fn(async () => agentsList);
    agents.refreshList = refreshList;
    const save = vi.fn(async () => false);
    const context = pageContext(gateway(snapshot(client)), agents);
    Object.assign(context.runtimeConfig, { save });
    const { page } = mountPage(client, "overview", context);
    page.read().onConfigSave();
    await waitForFast(() => expect(save).toHaveBeenCalledOnce());
    expect(refreshList).not.toHaveBeenCalled();
  });

  it("refreshes effective tools after saving tool settings for the same session", async () => {
    const saved = deferred<boolean>();
    const roster = deferred<typeof agentsList>();
    let effectiveReads = 0;
    const request = toolsRequest(() => ({
      agentId: "main",
      profile: ++effectiveReads === 1 ? "messaging" : "full",
      groups: [],
    }));
    const client = createTestGatewayClient(request);
    const agents = emptyAgents();
    agents.refreshList = vi.fn(() => roster.promise);
    const context = pageContext(gateway(snapshot(client)), agents);
    const { page } = mountPage(client, "tools", {
      ...context,
      runtimeConfig: { ...context.runtimeConfig, state: {}, save: () => saved.promise },
    } as unknown as ApplicationContext);
    await waitForFast(() =>
      expect(page.read().tools.toolsEffectiveResult?.profile).toBe("messaging"),
    );

    page.read().onConfigSave();
    await settle(saved, true);
    await settle(roster, agentsList);

    await waitForFast(() => expect(page.read().tools.toolsEffectiveResult?.profile).toBe("full"));
    expect(effectiveReads).toBe(2);
  });

  it("reads separate configured model catalogs when switching default and worker agents", async () => {
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      models: params?.agentId === "worker" ? workerModels : defaultModels,
    }));
    const { page, context } = mountPage(createTestGatewayClient(request));

    refreshPanel(page);
    await expectModels(page, defaultModels);

    context.settingsAgentSelection.set("worker");
    refreshPanel(page);
    await expectModels(page, workerModels);

    context.settingsAgentSelection.set("main");
    refreshPanel(page);
    await expectModels(page, defaultModels);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls).toEqual([
      ["models.list", { view: "configured", agentId: "main" }],
      ["models.list", { view: "configured", agentId: "worker" }],
    ]);
  });

  it.each(["empty", "retained rows", "rejected RPC"] as const)(
    "reports model catalog failure and permits recovery: %s",
    async (failure) => {
      const rejected = failure === "rejected RPC";
      const choices = failure === "retained rows" ? models("current") : [];
      const recovered = rejected ? nextModels : [];
      const request = vi.fn();
      if (rejected) {
        request.mockRejectedValueOnce(new Error("model catalog unavailable"));
      } else {
        request
          .mockResolvedValueOnce({ models: oldModels })
          .mockResolvedValueOnce({ models: choices, refreshFailed: true });
      }
      request.mockResolvedValueOnce({ models: recovered });
      const { page, currentGateway } = mountPage(createTestGatewayClient(request));

      refreshPanel(page);
      if (!rejected) {
        await waitForFast(() => expect(page.read().overview.modelCatalog[0]?.id).toBe("old"));
        emitCatalogChanged(currentGateway);
      }
      await waitForFast(() =>
        expect(page.read().overview.modelCatalogStatus.error).toBe(
          rejected
            ? "model catalog unavailable"
            : choices.length
              ? "Some models could not be refreshed. Open Models to try again."
              : "Models unavailable",
        ),
      );
      expect(page.read().overview.modelCatalog).toEqual(choices);

      page.read().overview.onModelCatalogOpen?.();
      await expectModels(page, recovered);
      await waitForFast(() => expect(page.read().overview.modelCatalogStatus.stale).toBe(false));
      expect(page.read().overview).toMatchObject({
        modelCatalogStatus: { error: null },
        modelCatalog: recovered,
      });
      expect(request.mock.calls).toEqual(
        Array.from({ length: rejected ? 2 : 3 }, () => [
          "models.list",
          { agentId: "main", view: "configured" },
        ]),
      );
    },
  );

  it.each(["publication", "reconnect"] as const)(
    "keeps picker opens cached until %s",
    async (change) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: oldModels })
        .mockResolvedValueOnce({ models: nextModels });
      const client = createTestGatewayClient(request);
      const { page, currentGateway } = mountPage(client);

      refreshPanel(page);
      refreshPanel(page);
      await expectModels(page, oldModels);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("models.list", { view: "configured", agentId: "main" });

      page.read().overview.onModelCatalogOpen?.();
      expect(request).toHaveBeenCalledTimes(1);

      page.read().overview.onModelCatalogOpen?.();
      await expectModels(page, oldModels);
      expect(request).toHaveBeenCalledTimes(1);

      if (change === "publication") {
        emitCatalogChanged(currentGateway);
      } else {
        emitGatewaySnapshot(currentGateway, snapshot(client, false));
        expect(page.read().overview.modelCatalog).toEqual([]);
        emitCatalogChanged(currentGateway);
        emitGatewaySnapshot(currentGateway, snapshot(client));
        refreshPanel(page);
      }
      await expectModels(page, nextModels);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(2, "models.list", {
        view: "configured",
        agentId: "main",
      });
    },
  );

  it.each(["client", "reconnect", "gateway source", "publication", "worker"] as const)(
    "rejects an old model read after a newer %s",
    async (replacement) => {
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
      } else if (replacement === "worker") {
        initial.context.settingsAgentSelection.set("worker");
        refreshPanel(page);
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

      await expectModels(page, nextModels);
      await settle(oldResult, { models: oldModels });

      expect(page.read().overview.modelCatalog).toEqual(nextModels);
      expect(oldRequest.mock.calls.length + nextRequest.mock.calls.length).toBe(2);
      if (replacement === "worker") {
        expect(oldRequest).toHaveBeenNthCalledWith(2, "models.list", {
          view: "configured",
          agentId: "worker",
        });
      }
    },
  );

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
    const unrelatedJobs = Array.from({ length: 50 }, (_, i) => cronJob(`other-${i}`, "other"));
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
    const { page } = mountPage(createTestGatewayClient(request), "cron");

    refreshPanel(page);

    await waitForFast(() =>
      expect(page.read().cron).toMatchObject({
        jobs: [implicitDefaultJob],
        scopedTotal: 1,
        scopedNextWakeAtMs,
      }),
    );
    expect(page.read().cron.status).toEqual({
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
    const { page } = mountPage(createTestGatewayClient(request), "cron");

    refreshPanel(page);

    await waitForFast(() => {
      expect(page.read().cron.jobs).toHaveLength(50);
      expect(page.read().cron).toMatchObject({ jobsTotal: 51, scopedTotal: 51, jobsHasMore: true });
    });

    page.read().cron.onLoadMore();
    await waitForFast(() => expect(page.read().cron.jobs).toHaveLength(51));

    expect(page.read().cron.jobs.at(-1)).toEqual(lastJob);
    expect(page.read().cron).toMatchObject({ jobsTotal: 51, scopedTotal: 51, jobsHasMore: false });
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
    const { page, context } = mountPage(createTestGatewayClient(request), "cron");

    refreshPanel(page);
    await waitForFast(() => expect(page.read().cron.jobs[0]?.id).toBe("main-job"));

    context.settingsAgentSelection.set("other");
    refreshPanel(page);
    expect(page.read().cron.jobs).toEqual([]);

    await waitForFast(() => expect(page.read().cron.jobs[0]?.id).toBe("other-job"));
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ agentId: "other" }),
    );
  });

  it.each(["snapshot", "refresh"] as const)(
    "keeps one pending cron load across another %s",
    async (change) => {
      const job = cronJob("pending-job", "main");
      const pendingJobs = deferred<CronJobsListResult>();
      const request = pendingCronRequest(job, pendingJobs.promise);
      const client = createTestGatewayClient(request);
      const { page, currentGateway } = mountPage(client, "cron");

      if (change === "snapshot") {
        refreshPanel(page);
        await waitForFast(() => expect(page.read().cron.loading).toBe(true));
        emitGatewaySnapshot(currentGateway, snapshot(client));
      } else {
        expect(page.read().cron.loading).toBe(true);
        page.read().cron.onRefresh();
      }
      expect(page.read().cron.loading).toBe(true);
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "cron.list" && params?.limit === 50,
        ),
      ).toHaveLength(1);

      pendingJobs.resolve(cronListResponse([job]));
      await waitForFast(() =>
        expect(page.read().cron).toMatchObject({ jobs: [job], loading: false }),
      );
    },
  );

  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client, false));
    const selection = settingsSelection(agentsList);
    const agents = emptyAgents();
    agents.state.agentsList = null;
    const route = agentsRouteData(currentGateway, agentsList, "main", selection);
    const context = { ...pageContext(currentGateway, agents), settingsAgentSelection: selection };
    const page = createAgentsPage(context, route);
    expect(page.read().agentsList).toBe(agentsList);
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
    expect(replacement.read()).toMatchObject({ agentsList: null, selectedAgentId: null });
  });

  it("rejects preloaded data after a same-client gateway source replacement", async () => {
    const client = {} as GatewayBrowserClient;
    const preloadedSnapshot = snapshot(client);
    const preloadedGateway = gateway(preloadedSnapshot);
    const currentGateway = gateway(preloadedSnapshot);
    const ensureList = vi.fn(async () => null);
    const agents = emptyAgents();
    agents.state.agentsList = null;
    agents.ensureList = ensureList;
    const context = pageContext(currentGateway, agents);
    const page = createAgentsPage(context, agentsRouteData(preloadedGateway));
    await Promise.resolve();
    expect(page.read().agentsList).toBeNull();
    expect(ensureList).toHaveBeenCalledOnce();
  });

  it.each(["client", "disconnect", "capability"] as const)(
    "retires pending files after %s replacement",
    async (change) => {
      const first = deferred<AgentsFilesListResult>();
      const second = deferred<AgentsFilesListResult>();
      const ensureFiles = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const cached = { name: "cached.md", path: "/synthetic/cached.md", missing: false };
      const client = createTestGatewayClient(
        vi.fn(async () => ({ file: { ...cached, content: "keep" } })),
      );
      const currentGateway = gateway(snapshot(client));
      const context = pageContext(currentGateway, agentsCapability(ensureFiles));
      let page: Page;
      if (change === "disconnect") {
        page = createAgentsPage(context);
        page.read().agentFiles.onSelectFile("cached.md");
        await waitForFast(() =>
          expect(agentFileValues(page.read().agentFiles, "content")).toEqual({
            "cached.md": "keep",
          }),
        );
        page.setRouteData(
          agentsRouteData(
            currentGateway,
            context.agents.state.agentsList,
            "main",
            context.settingsAgentSelection,
          ),
        );
      } else {
        page = createAgentsPage(context, agentsRouteData(currentGateway));
      }
      expect(page.read().agentFiles.agentFilesLoading).toBe(true);
      if (change === "client") {
        emitGatewaySnapshot(currentGateway, snapshot({} as GatewayBrowserClient));
        await waitForFast(() => expect(ensureFiles).toHaveBeenCalledTimes(2));
      } else if (change === "disconnect") {
        emitGatewaySnapshot(currentGateway, snapshot(client, false));
        expect(page.read().agentFiles.agentFilesLoading).toBe(false);
        expect(agentFileValues(page.read().agentFiles, "content")).toEqual({ "cached.md": "keep" });
        emitGatewaySnapshot(currentGateway, snapshot(client));
        expect(ensureFiles).toHaveBeenCalledTimes(2);
      } else {
        page.dispose();
        page = createAgentsPage(
          { ...context, agents: agentsCapability(() => second.promise) },
          agentsRouteData(currentGateway),
        );
      }
      expect(page.read().agentFiles.agentFilesLoading).toBe(true);

      await settle(first, files("main", "old"));
      expect(page.read().agentFiles).toMatchObject({
        agentFilesList: null,
        agentFilesLoading: true,
      });
      second.resolve(files("main", "new"));
      await waitForFast(() => expect(page.read().agentFiles.agentFilesList?.workspace).toBe("new"));
      expect(page.read().agentFiles.agentFilesLoading).toBe(false);
    },
  );

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
      expect(page.read().agentFiles.agentFileEditors["AGENTS.md"]?.content).toBe("# Instructions"),
    );
    expect(page.read().agentFiles.agentFileActive).toBe("AGENTS.md");
    expect(request).toHaveBeenCalledWith("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
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
    const context = pageContext(currentGateway, emptyAgents(), {
      agentIdentity: identity(oldEnsure.promise, "Old identity"),
    });
    const page = createAgentsPage(context);
    page.dispose();
    const replacement = createAgentsPage({
      ...context,
      agentIdentity: identity(nextEnsure.promise, "New identity"),
    });
    expect(replacement.read().agentIdentityById).toEqual({});
    await settle(oldEnsure, undefined);
    expect(replacement.read().agentIdentityById).toEqual({});
    nextEnsure.resolve();
    await waitForFast(() =>
      expect(replacement.read().agentIdentityById).toEqual({
        main: { agentId: "main", name: "New identity" },
      }),
    );
  });
});
