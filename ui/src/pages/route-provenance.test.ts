// @vitest-environment node
import type { PageDefinition, RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { page as agentsPage } from "./agents/route.ts";
import { page as devicesPage } from "./devices/route.ts";
import { page as modelProvidersPage } from "./model-providers/route.ts";
import { pages as pluginPages } from "./plugins/route.tsx";
import { pages as skillPages } from "./skills/route.ts";
import type { SkillsRouteData } from "./skills/skills-page.tsx";
import { page as usagePage } from "./usage/route.tsx";

const selection = (id: string | null, intentRevision = 0) => ({
  state: { selectedId: id, scopeId: id },
  intentRevision,
});
type RouteContext = {
  agents?: { state?: { agentsList: null; agentsError?: null }; ensureList: () => Promise<unknown> };
  agentSelection?: ReturnType<typeof selection>;
  settingsAgentSelection?: ReturnType<typeof selection>;
};

const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/", search: "", hash: "" },
  deps: "",
  cause: "preload",
};

function provenance(request: () => Promise<unknown> = vi.fn(async () => ({})), connected = true) {
  const client = { request } as unknown as GatewayBrowserClient;
  const original: ApplicationGatewaySnapshot = {
    client: connected ? client : null,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let current = original;
  const gateway = {
    get snapshot() {
      return current;
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    client,
    replace(nextClient = client, nextConnected = false) {
      current = {
        ...original,
        client: nextClient,
        phase: nextConnected ? "connected" : "reconnecting",
      };
    },
    async load<T extends Pick<SkillsRouteData, "gateway" | "gatewaySnapshot">>(
      route: Pick<PageDefinition<string, ApplicationContext, unknown, T>, "loader">,
      overrides: RouteContext = {},
    ): Promise<T> {
      if (!route.loader) {
        throw new Error("route has no loader");
      }
      const data = (await route.loader(
        { gateway, ...overrides } as unknown as ApplicationContext,
        loaderOptions,
      )) as T;
      expect(data.gateway).toBe(gateway);
      expect(data.gatewaySnapshot).toBe(original);
      return data;
    },
  };
}

it("records the exact gateway source and snapshot for synchronous route state", async () => {
  const source = provenance(undefined, false);
  await source.load(agentsPage, {
    settingsAgentSelection: selection(null),
    agents: {
      state: { agentsList: null, agentsError: null },
      ensureList: vi.fn(async () => null),
    },
  });
  await source.load(devicesPage);
});

it("keeps usage provenance from before its async preload", async () => {
  const source = provenance();
  const request = source.load(usagePage, { agentSelection: selection(null) });
  source.replace();
  await request;
});

it("keeps model providers provenance from before its lazy module load", async () => {
  const originalRequest = vi.fn(async () => ({}));
  const replacementRequest = vi.fn(async () => ({}));
  const source = provenance(originalRequest);
  const request = source.load(modelProvidersPage, {
    settingsAgentSelection: selection("main"),
  });

  source.replace(provenance(replacementRequest).client, true);
  const data = await request;

  expect(data.client).toBeNull();
  expect(originalRequest).not.toHaveBeenCalled();
  expect(replacementRequest).not.toHaveBeenCalled();
});

it("keeps skills provenance from before its async preload", async () => {
  const requestMethod = vi.fn(async () => ({ skills: [] }));
  const source = provenance(requestMethod);
  const agentsList = {
    defaultId: "main",
    agents: [{ id: "main" }, { id: "research" }],
  };
  const agentsReady = deferred<typeof agentsList>();
  const agents = { ensureList: vi.fn(() => agentsReady.promise) };
  const selected = selection("research", 7);
  const request = source.load(skillPages[0], {
    agents,
    agentSelection: selected,
  });

  source.replace();
  selected.intentRevision += 1;
  agentsReady.resolve(agentsList);
  const data = await request;

  expect(requestMethod).toHaveBeenCalledWith("skills.status", { agentId: "research" });
  expect(data).toMatchObject({ selectedAgentId: "research", selectionIntentRevision: 7 });
  expect(data.agents).toBe(agents);
});

it("keeps plugins provenance from before its async preload", async () => {
  const result = { plugins: [], diagnostics: [], mutationAllowed: true };
  const response = deferred<typeof result>();
  const requestMethod = vi.fn(() => response.promise);
  const source = provenance(requestMethod);
  const request = source.load(pluginPages[0]);

  source.replace();
  response.resolve(result);
  const data = await request;

  expect(requestMethod).toHaveBeenCalledWith("plugins.list", {});
  expect(data.result).toEqual(result);
});
