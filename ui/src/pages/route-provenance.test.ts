// @vitest-environment node
import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { page as agentsPage, type AgentsRouteData } from "./agents/route.ts";
import type { DevicesRouteData } from "./devices/devices-page.tsx";
import { page as devicesPage } from "./devices/route.ts";
import {
  page as modelProvidersPage,
  type ModelProvidersRouteData,
} from "./model-providers/route.ts";
import type { PluginsRouteData } from "./plugins/route-data.ts";
import { pages as pluginPages } from "./plugins/route.ts";
import { pages as skillPages } from "./skills/route.ts";
import type { SkillsRouteData } from "./skills/skills-page.tsx";
import { page as usagePage } from "./usage/route.ts";
import type { UsageRouteData } from "./usage/types.ts";

const pluginsPage = pluginPages[0];
const skillsPage = skillPages[0];

type RouteWithLoader = {
  loader?: (context: ApplicationContext, options: RouteLoaderOptions) => unknown;
};

const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/", search: "", hash: "" },
  deps: "",
  cause: "preload",
};

function snapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function provenance(request: () => Promise<unknown> = vi.fn(async () => ({})), connected = true) {
  const client = { request } as unknown as GatewayBrowserClient;
  const original = snapshot(connected ? client : null, connected);
  let current = original;
  const gateway = {
    get snapshot() {
      return current;
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    client,
    gateway,
    replace(nextClient = client, nextConnected = false) {
      current = snapshot(nextClient, nextConnected);
    },
    expectSource(data: {
      gateway: ApplicationContext["gateway"];
      gatewaySnapshot: ApplicationGatewaySnapshot;
    }) {
      expect(data.gateway).toBe(gateway);
      expect(data.gatewaySnapshot).toBe(original);
    },
  };
}

async function loadRoute<T>(route: RouteWithLoader, context: ApplicationContext): Promise<T> {
  if (!route.loader) {
    throw new Error("route has no loader");
  }
  return (await route.loader(context, loaderOptions)) as T;
}

describe("route preload gateway provenance", () => {
  it("records the exact gateway source and snapshot for synchronous route state", async () => {
    const source = provenance(undefined, false);
    const agentsData = await loadRoute<AgentsRouteData>(agentsPage, {
      gateway: source.gateway,
      settingsAgentSelection: { state: { selectedId: null, scopeId: null }, intentRevision: 0 },
      agents: {
        state: { agentsList: null, agentsError: null },
        ensureList: vi.fn(async () => null),
      },
    } as unknown as ApplicationContext);
    source.expectSource(agentsData);

    const devicesData = await loadRoute<DevicesRouteData>(devicesPage, {
      gateway: source.gateway,
    } as unknown as ApplicationContext);
    source.expectSource(devicesData);
  });

  it("keeps usage provenance from before its async preload", async () => {
    const source = provenance();
    const request = loadRoute<UsageRouteData>(usagePage, {
      gateway: source.gateway,
      agentSelection: { state: { selectedId: null, scopeId: null } },
    } as unknown as ApplicationContext);

    source.replace();
    source.expectSource(await request);
  });

  it("keeps model providers provenance from before its lazy module load", async () => {
    const originalRequest = vi.fn(async () => ({}));
    const replacementRequest = vi.fn(async () => ({}));
    const source = provenance(originalRequest);
    const request = loadRoute<ModelProvidersRouteData>(modelProvidersPage, {
      gateway: source.gateway,
      agents: {
        state: { agentsList: null },
        ensureList: vi.fn(async () => ({
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [{ id: "main" }],
        })),
      },
      agentSelection: { state: { selectedId: "research", scopeId: "research" }, intentRevision: 0 },
      settingsAgentSelection: { state: { selectedId: "main", scopeId: "main" }, intentRevision: 0 },
    } as unknown as ApplicationContext);

    source.replace(provenance(replacementRequest).client, true);
    const data = await request;

    source.expectSource(data);
    expect(data.client).toBeNull();
    expect(originalRequest).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps skills provenance from before its async preload", async () => {
    const requestMethod = vi.fn(async () => ({ skills: [] }));
    const source = provenance(requestMethod);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global" as const,
      agents: [{ id: "main" }, { id: "research" }],
    };
    const agentsReady = deferred<typeof agentsList>();
    const agents = {
      ensureList: vi.fn(() => agentsReady.promise),
    } as unknown as ApplicationContext["agents"];
    const selection = {
      state: { selectedId: "research", scopeId: "research" },
      intentRevision: 7,
    };
    const request = loadRoute<SkillsRouteData>(skillsPage, {
      gateway: source.gateway,
      agents,
      agentSelection: selection,
    } as unknown as ApplicationContext);

    source.replace();
    selection.intentRevision += 1;
    agentsReady.resolve(agentsList);
    const data = await request;

    expect(requestMethod).toHaveBeenCalledWith("skills.status", { agentId: "research" });
    expect(data.selectedAgentId).toBe("research");
    expect(data.selectionIntentRevision).toBe(7);
    source.expectSource(data);
    expect(data.agents).toBe(agents);
  });

  it("keeps plugins provenance from before its async preload", async () => {
    const result = { plugins: [], diagnostics: [], mutationAllowed: true };
    const response = deferred<typeof result>();
    const requestMethod = vi.fn(() => response.promise);
    const source = provenance(requestMethod);
    const request = loadRoute<PluginsRouteData>(pluginsPage, {
      gateway: source.gateway,
    } as unknown as ApplicationContext);

    source.replace();
    response.resolve(result);
    const data = await request;

    expect(requestMethod).toHaveBeenCalledWith("plugins.list", {});
    source.expectSource(data);
    expect(data.result).toEqual(result);
  });
});
