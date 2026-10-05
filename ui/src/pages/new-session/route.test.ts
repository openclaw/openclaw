import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionModelSearch } from "./model-location.ts";
import { page } from "./route.ts";

// The loader is exercised through the page contract so route.ts keeps its
// internals unexported; new-session routes never resolve to RouteNotFound.
const loadNewSessionData = (context: ApplicationContext, search: string) =>
  page.loader?.(context, { location: { search } } as never) as Promise<NewSessionRouteData>;

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
  it.each(["current", "failed", "retired-agent"] as const)(
    "resolves catalog routes only against %s live discovery",
    async (outcome) => {
      const roster: NonNullable<ApplicationContext["agents"]["state"]["agentsList"]> = {
        defaultId: "current",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "current" }],
      };
      const { context, agentsState, ensureList, request } = createContext({
        assistantAgentId: "old",
        agentsList: outcome === "retired-agent" ? roster : null,
      });
      ensureList.mockImplementation(async () => {
        if (outcome === "current") {
          agentsState.agentsList = roster;
        }
        return agentsState.agentsList;
      });
      const data = await loadNewSessionData(
        context,
        outcome === "retired-agent" ? "?agent=old&catalog=claude" : "?catalog=claude",
      );
      expect(ensureList).toHaveBeenCalledTimes(outcome === "retired-agent" ? 0 : 1);
      expect(data.agentId).toBe(outcome === "failed" ? "" : "current");
      if (outcome === "failed") {
        expect(request).not.toHaveBeenCalled();
      } else {
        expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
          agentId: "current",
          catalogId: "claude",
          limitPerHost: 1,
        });
      }
    },
  );

  it.each([
    { label: "qualified", model: "example/model-one", expected: "example/model-one" },
    { label: "unqualified", model: "unqualified", expected: undefined },
    { label: "control character", model: "example/model\n", expected: undefined },
    { label: "oversized", model: `example/${"x".repeat(2048)}`, expected: undefined },
  ])("validates $label model intent without creating a session", async ({ model, expected }) => {
    const { context, request } = createContext({ assistantAgentId: "main", agentsList: null });
    const data = await loadNewSessionData(
      context,
      expected
        ? newSessionModelSearch("main", model)
        : `?agent=main&model=${encodeURIComponent(model)}`,
    );
    expect(data.requestedModel).toBe(expected);
    expect(data).toMatchObject({
      agentId: "main",
      requestedAgentId: "main",
      startTerminal: false,
      catalogId: "",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "missing"] as const)("rejects %s group defaults", async (groupStatus) => {
    const unavailable = groupStatus === "unavailable";
    const context = {
      sessions: {
        state: {
          groupSettings: unavailable
            ? [{ name: "Client", position: 0, cwd: "/gateway-a/client", worktree: true }]
            : [],
        },
        groupsLoad: vi.fn(async () => (unavailable ? null : [])),
        groupsGeneration: vi.fn(() => 1),
        groupsStatus: vi.fn(() => (unavailable ? "unavailable" : "ready")),
      },
    } as unknown as ApplicationContext;
    const group = unavailable ? "Client" : "Deleted";
    const data = await loadNewSessionData(context, `?group=${group}`);
    expect(data.group).toBe(group);
    expect(data.groupStatus).toBe(groupStatus);
    expect(data.groupCwd).toBe("");
    expect(data.groupWorktree).toBe(false);
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
});
