import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionModelSearch } from "./model-location.ts";
import { page } from "./route.ts";

const load = (context: ApplicationContext, search: string) =>
  page.loader?.(context, { location: { search } } as never) as Promise<NewSessionRouteData>;

function roster(defaultId: string, ids = [defaultId]) {
  return {
    defaultId,
    mainKey: "main",
    scope: "per-sender" as const,
    agents: ids.map((id) => ({ id })),
  };
}

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
  const snapshot: Pick<
    ApplicationGatewaySnapshot,
    "client" | "phase" | "hello" | "assistantAgentId"
  > = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["sessions.catalog.list"] },
    },
    assistantAgentId: params.assistantAgentId,
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
    agents: { state: agentsState, ensureList },
  } as unknown as ApplicationContext;
  return { agentsState, client, context, ensureList, request };
}

function expectCatalog(request: ReturnType<typeof createContext>["request"], agentId: string) {
  expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
    agentId,
    catalogId: "claude",
    limitPerHost: 1,
  });
}

it.each(["current", "failed", "retired-agent"] as const)(
  "requires %s live discovery",
  async (outcome) => {
    const currentRoster = roster("current");
    const { context, agentsState, ensureList, request } = createContext({
      assistantAgentId: "old",
      agentsList: outcome === "retired-agent" ? currentRoster : null,
    });
    ensureList.mockImplementation(async () => {
      if (outcome === "current") {
        agentsState.agentsList = currentRoster;
      }
      return agentsState.agentsList;
    });
    const data = await load(
      context,
      outcome === "retired-agent" ? "?agent=old&catalog=claude" : "?catalog=claude",
    );
    expect(ensureList).toHaveBeenCalledTimes(outcome === "retired-agent" ? 0 : 1);
    expect(data.agentId).toBe(outcome === "failed" ? "" : "current");
    if (outcome === "failed") {
      expect(request).not.toHaveBeenCalled();
    } else {
      expectCatalog(request, "current");
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
  const data = await load(
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
      groupsStatus: vi.fn(() => (unavailable ? "unavailable" : "ready")),
    },
  } as unknown as ApplicationContext;
  const group = unavailable ? "Client" : "Deleted";
  const data = await load(context, `?group=${group}`);
  expect(data).toMatchObject({ group, groupStatus, groupCwd: "", groupWorktree: false });
});

it("waits for the replacement client's roster before preserving a valid route agent", async () => {
  const { agentsState, client, context, request } = createContext({
    assistantAgentId: "roboclaw",
    agentsList: roster("main"),
    staleRosterClient: true,
  });

  const pending = await load(context, "?agent=research&catalog=claude");

  expect(pending.agentId).toBe("");
  expect(request).not.toHaveBeenCalled();

  agentsState.client = client;
  agentsState.agentsList = roster("roboclaw", ["roboclaw", "research"]);
  const data = await load(context, "?agent=research&catalog=claude");

  expect(data.agentId).toBe("research");
  expectCatalog(request, "research");
});
