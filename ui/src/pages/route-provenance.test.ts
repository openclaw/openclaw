// @vitest-environment node
import type { PageDefinition, RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { createRouteLoaderOptions } from "../test-helpers/route-loader-options.ts";
import { page as devicesPage } from "./devices/route.ts";
import { pages as pluginPages } from "./plugins/route.tsx";
import { pages as skillPages } from "./skills/route.ts";
import type { SkillsRouteData } from "./skills/view-types.ts";

const selection = (id: string | null, intentRevision = 0) => ({
  state: { selectedId: id, scopeId: id },
  intentRevision,
});
type RouteContext = {
  agents?: { ensureList: () => Promise<unknown> };
  agentSelection?: ReturnType<typeof selection>;
};

const loaderOptions: RouteLoaderOptions = createRouteLoaderOptions(
  { pathname: "/", search: "", hash: "" },
  "",
  "preload",
);

function provenance(request: () => Promise<unknown> = vi.fn(async () => ({})), connected = true) {
  const client = { request } as unknown as GatewayBrowserClient;
  const original = createApplicationGatewaySnapshot({
    client: connected ? client : null,
    phase: connected ? "connected" : "reconnecting",
  });
  const { gateway, publish } = createApplicationGateway(original);
  return {
    replace() {
      publish({ ...original, phase: "reconnecting" });
    },
    async load<T extends Pick<SkillsRouteData, "gateway" | "gatewaySnapshot">>(
      route: Pick<PageDefinition<string, ApplicationContext, unknown, T>, "loader">,
      overrides: RouteContext = {},
    ): Promise<T> {
      const data = (await route.loader!(
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
  await provenance(undefined, false).load(devicesPage);
});

it("keeps skills provenance from before its async preload", async () => {
  const requestMethod = vi.fn(async () => ({ skills: [] }));
  const source = provenance(requestMethod);
  const agentsList = { defaultId: "main", agents: [{ id: "main" }, { id: "research" }] };
  const agentsReady = deferred<typeof agentsList>();
  const agents = { ensureList: vi.fn(() => agentsReady.promise) };
  const selected = selection("research", 7);
  const request = source.load(skillPages[0], { agents, agentSelection: selected });

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
