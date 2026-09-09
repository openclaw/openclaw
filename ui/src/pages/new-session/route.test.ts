import { createRouter } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { routeKey, routeKeyFromSearch } from "./catalog-target.ts";
import type { NewSessionRouteData } from "./location.ts";
import { page } from "./route.ts";

// The loader is exercised through the page contract so route.ts keeps its
// internals unexported; new-session routes never resolve to RouteNotFound.
const loadNewSessionData = (context: ApplicationContext, search: string) =>
  page.loader?.(context, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/new", search, hash: "" },
    deps: search,
    cause: "navigation",
  }) as Promise<NewSessionRouteData>;

function createContext(params: {
  assistantAgentId: string | null;
  agentsList: ApplicationContext["agents"]["state"]["agentsList"];
  staleRosterClient?: boolean;
}) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.catalog.list") {
      throw new Error(`unexpected request: ${method}`);
    }
    return { catalogs: [] };
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["sessions.catalog.list"] },
    },
    assistantAgentId: params.assistantAgentId,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const ensureList = vi.fn(async () => params.agentsList);
  const agentsState = {
    client: params.staleRosterClient
      ? ({ request: vi.fn() } as unknown as GatewayBrowserClient)
      : client,
    connected: true,
    agentsList: params.agentsList,
  };
  const context = {
    gateway: { snapshot },
    agents: {
      state: agentsState,
      ensureList,
    },
  } as unknown as ApplicationContext;
  return { agentsState, client, context, ensureList, request };
}

describe("new-session route catalog target", () => {
  it("keeps the replacement agent catalog when navigation cancels a lazy group route", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.groups.list") {
        const agentId = typeof params?.agentId === "string" ? params.agentId : "main";
        return { agentId, groups: [{ name: `${agentId} group`, position: 0 }] };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      return {};
    });
    const { gateway, selection, sessions, connect } = createSubscriptionHydrationHarness(
      request,
      "main",
    );
    const context = {
      gateway,
      agentSelection: selection,
      sessions,
    } as unknown as ApplicationContext;
    const router = createRouter<
      "new-session" | "other",
      ApplicationContext,
      null,
      NewSessionRouteData | undefined
    >({
      routes: [
        { ...page, component: () => null },
        { id: "other", path: "/other", component: () => null },
      ],
    });
    const location = { pathname: "/new", search: "?agent=writer&group=writer+group", hash: "" };
    try {
      connect();
      await sessions.groupsLoad();
      expect(sessions.state.groups).toEqual(["main group"]);
      request.mockClear();

      const loading = router.navigate("new-session", context, {}, location);
      // import() yields even when cached; this real navigation retires that loader first.
      await router.navigate("other", context);
      await loading;

      expect(router.getState().matches[0]?.routeId).toBe("other");
      expect(selection.state.selectedId).toBe("main");
      expect(sessions.state.groupsAgentId).toBe("main");
      expect(sessions.state.groups).toEqual(["main group"]);
      expect(
        request.mock.calls.filter(([method]) => method.startsWith("sessions.groups.")),
      ).toEqual([]);

      await router.navigate("new-session", context, {}, location);
      expect(router.getState().matches[0]?.data).toMatchObject({
        agentId: "writer",
        group: "writer group",
        groupStatus: "resolved",
      });
      expect(selection.state.selectedId).toBe("writer");
      expect(sessions.state.groupsAgentId).toBe("writer");
      expect(sessions.state.groups).toEqual(["writer group"]);
    } finally {
      router.stop();
      sessions.dispose();
    }
  });

  it("does not apply group defaults from a retired connection", async () => {
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      sessions: {
        state: {
          groupSettings: [
            { name: "Client", position: 0, cwd: "/gateway-a/client", worktree: true },
          ],
        },
        groupsLoad: vi.fn(async () => null),
        groupsGeneration: vi.fn(() => 1),
        groupsStatus: vi.fn(() => "unavailable"),
      },
    } as unknown as ApplicationContext;

    const data = await loadNewSessionData(context, "?group=Client");

    expect(data.groupStatus).toBe("unavailable");
    expect(data.groupCwd).toBe("");
    expect(data.groupWorktree).toBe(false);
  });

  it("marks a deleted group target missing", async () => {
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      sessions: {
        state: { groupSettings: [] },
        groupsLoad: vi.fn(async () => []),
        groupsGeneration: vi.fn(() => 1),
        groupsStatus: vi.fn(() => "ready"),
      },
    } as unknown as ApplicationContext;

    const data = await loadNewSessionData(context, "?group=Deleted");

    expect(data.group).toBe("Deleted");
    expect(data.groupStatus).toBe("missing");
  });

  it.each(["", "&catalog=claude"])(
    "keeps agentless group defaults and catalog targets on the selected agent (%s)",
    async (catalogSearch) => {
      const { context, request } = createContext({
        assistantAgentId: "main",
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "research" }],
        },
      });
      const settings = [{ name: "Shared", position: 0, cwd: "/research", worktree: true }];
      Object.assign(context, {
        agentSelection: { state: { selectedId: "research" } },
        sessions: {
          state: { groupsAgentId: "research", groupSettings: settings },
          groupsLoad: vi.fn(async () => settings),
          groupsGeneration: vi.fn(() => 1),
          groupsStatus: vi.fn(() => "ready"),
        },
      });
      const search = `?group=Shared${catalogSearch}`;

      const data = await loadNewSessionData(context, search);

      expect(data).toMatchObject({
        agentId: "research",
        requestedAgentId: "",
        groupStatus: "resolved",
        groupCwd: "/research",
        groupWorktree: true,
      });
      expect(routeKey(data)).toBe(routeKeyFromSearch(search));
      if (catalogSearch) {
        expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
          agentId: "research",
          catalogId: "claude",
          limitPerHost: 1,
        });
      } else {
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("defers an unvalidated route agent before roster hydration", async () => {
    const { context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: null,
    });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("reconciles a retired route agent against the loaded roster", async () => {
    const { context, request } = createContext({
      assistantAgentId: "main",
      agentsList: {
        defaultId: "roboclaw",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "roboclaw" }],
      },
    });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("roboclaw");
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "roboclaw",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("defers catalog retries when neither roster nor hello supplies an agent", async () => {
    const { context, request } = createContext({ assistantAgentId: null, agentsList: null });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for the replacement client's roster before preserving a valid route agent", async () => {
    const { agentsState, client, context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
      staleRosterClient: true,
    });

    const pending = await loadNewSessionData(context, "?agent=research&catalog=claude");

    expect(pending.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();

    agentsState.client = client;
    agentsState.agentsList = {
      defaultId: "roboclaw",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "roboclaw" }, { id: "research" }],
    };
    const data = await loadNewSessionData(context, "?agent=research&catalog=claude");

    expect(data.agentId).toBe("research");
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("reuses the current gateway client across route retries", async () => {
    const { client, context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: null,
    });

    await loadNewSessionData(context, "?catalog=claude");
    await loadNewSessionData(context, "?catalog=claude");

    expect(context.gateway.snapshot.client).toBe(client);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
