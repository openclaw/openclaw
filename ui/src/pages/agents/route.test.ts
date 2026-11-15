import { createRouter, type RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { INTERNAL_AGENT_PATH_PARAM } from "../../app-route-paths.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import {
  agentsCapability,
  gateway,
  pageContext,
  settingsSelection,
  snapshot,
} from "./agents-page.test-support.ts";
import { page, type AgentsRouteData } from "./route.ts";

const agentsList: AgentsListResult = makeBootRoster({
  agents: [
    { id: "main", name: "Main" },
    { id: "ordinary-looking-id", kind: "system", name: "System" },
    { id: "research", name: "Research" },
  ],
});

function location(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

async function loadRoute(url: string, basePath = "") {
  const parsed = new URL(url, "https://control.test");
  const request = vi.fn(async () => agentsList);
  const currentGateway = gateway(snapshot({ request } as unknown as GatewayBrowserClient));
  const agents = createAgentCapability(currentGateway);
  const context = {
    basePath,
    gateway: currentGateway,
    settingsAgentSelection: settingsSelection(null),
    agents,
  } as unknown as ApplicationContext;
  if (!page.loader) {
    throw new Error("agents route has no loader");
  }
  const result = (await page.loader(
    context,
    createRouteLoaderOptions(
      {
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
      },
      `${parsed.pathname}\u0000${parsed.search}\u0000${parsed.hash}`,
      "preload",
    ),
  )) as AgentsRouteData;
  expect(request).toHaveBeenCalledExactlyOnceWith("agents.list", {
    includeSessionPlacement: true,
  });
  expect(agents.state.agentsList).toBe(agentsList);
  agents.dispose();
  return {
    location: result.location,
    requestedAgentId: result.requestedAgentId,
    panel: result.panel,
    ...(result.canonicalLocation ? { canonicalLocation: result.canonicalLocation } : {}),
  };
}

describe("agents route", () => {
  it("retires selection receipts while keeping the warm roster, module, and current intent", async () => {
    const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
    agents.state.agentsList = agentsList;
    const context = { ...pageContext(gateway(snapshot(null, false)), agents), basePath: "" };
    const selection = context.settingsAgentSelection;
    const component = vi.fn(async () => ({ renderSolid: () => null }));
    const loader = vi.fn<NonNullable<typeof page.loader>>(page.loader);
    const router = createRouter({ routes: [{ ...page, component, loader }] });
    try {
      expect(component).not.toHaveBeenCalled();
      for (const agentId of ["main", "research", "main", "main"]) {
        selection.set(agentId);
        await router.navigate("agents", context, {}, location(`/settings/agents/${agentId}`));
        expect(router.getState().cachedMatches).toHaveLength(0);
        expect(router.getState().matches[0]?.data).toMatchObject({
          requestedAgentId: agentId,
          settingsAgentSelection: selection,
          selectionIntentRevision: selection.intentRevision,
        });
      }
      expect(component).toHaveBeenCalledTimes(1);

      selection.set("research");
      const destination = location("/settings/agents/research");
      const preloadSearch = new URLSearchParams({
        [INTERNAL_AGENT_PATH_PARAM]: destination.pathname,
      });
      loader.mockClear();
      await router.preloadLocation(location(`/settings/agents?${preloadSearch}`), context);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(loader.mock.calls[0]?.[1].cause).toBe("preload");
      expect(router.getState().cachedMatches).toHaveLength(0);
      await router.navigate("agents", context, {}, destination);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(router.getState().cachedMatches).toHaveLength(0);
      expect(router.getState().matches[0]?.data).toMatchObject({
        requestedAgentId: "research",
        selectionIntentRevision: selection.intentRevision,
      });
      expect(component).toHaveBeenCalledTimes(1);
      expect(agents.ensureList).not.toHaveBeenCalled();
    } finally {
      router.stop();
    }
  });

  it("keeps a requested agent and panel when the roster loads on a cold deep link", async () => {
    const result = await loadRoute("/settings/agents/research/tools");

    expect(result.requestedAgentId).toBe("research");
    expect(result.panel).toBe("tools");
    expect(result.canonicalLocation).toBeUndefined();
  });

  it.each([
    ["/settings/agents", null, "overview"],
    ["/settings/agents/research", "research", "overview"],
    ["/settings/agents/research/overview", "research", "overview"],
    ["/settings/agents/research/files", "research", "files"],
  ] as const)("reads %s without rewriting it", async (url, requestedAgentId, panel) => {
    const result = await loadRoute(url);
    expect(result).toMatchObject({ requestedAgentId, panel, location: location(url) });
    expect(result.canonicalLocation).toBeUndefined();
  });

  it("normalizes a legacy agent query once and preserves other URL state", async () => {
    expect(await loadRoute("/settings/agents?agent=team.writer&probe=1#catalog")).toEqual({
      location: location("/settings/agents?agent=team.writer&probe=1#catalog"),
      requestedAgentId: "team.writer",
      panel: "overview",
      canonicalLocation: location("/settings/agents/team%2Ewriter?probe=1#catalog"),
    });
  });

  it("prefers a canonical path over a stale legacy query", async () => {
    expect(await loadRoute("/settings/agents/research/tools?agent=main&probe=1")).toEqual({
      location: location("/settings/agents/research/tools?agent=main&probe=1"),
      requestedAgentId: "research",
      panel: "tools",
      canonicalLocation: location("/settings/agents/research/tools?probe=1"),
    });
  });

  it("normalizes an unknown panel to the agent default panel path", async () => {
    expect(await loadRoute("/ui/settings/agents/research/unknown?probe=1#files", "/ui")).toEqual({
      location: location("/ui/settings/agents/research/unknown?probe=1#files"),
      requestedAgentId: "research",
      panel: "overview",
      canonicalLocation: location("/ui/settings/agents/research?probe=1#files"),
    });
  });

  it("drops a legacy slash-containing agent id to the bare route", async () => {
    expect(await loadRoute("/settings/agents?agent=team%2Fwriter")).toEqual({
      location: location("/settings/agents?agent=team%2Fwriter"),
      requestedAgentId: null,
      panel: "overview",
      canonicalLocation: location("/settings/agents"),
    });
  });

  it.each([".", ".."])('drops the legacy dot-segment agent id "%s"', async (agentId) => {
    expect(await loadRoute(`/settings/agents?agent=${encodeURIComponent(agentId)}`)).toEqual({
      location: location(`/settings/agents?agent=${encodeURIComponent(agentId)}`),
      requestedAgentId: null,
      panel: "overview",
      canonicalLocation: location("/settings/agents"),
    });
  });

  it("recovers the dynamic pathname without leaking the internal router parameter", async () => {
    expect(
      await loadRoute(
        "/settings/agents?__openclawAgentPath=%2Fsettings%2Fagents%2Fresearch%2Fmemory&probe=1",
      ),
    ).toEqual({
      location: location("/settings/agents/research/memory?probe=1"),
      requestedAgentId: "research",
      panel: "memory",
    });
  });
});
