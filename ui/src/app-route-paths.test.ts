// @vitest-environment node
import {
  CONTROL_UI_RESERVED_ROUTE_SEGMENTS,
  isControlUiReservedRouteSegment,
} from "@openclaw/session-url-contract";
import { notFound, type RouteLocation, type RouterHistory } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  agentRouteFromPath,
  APP_ROUTE_IDS,
  APP_ROUTE_OFFLINE_PREFIXES,
  clawCatalogPackageNameFromPath,
  CONTROL_UI_DOCUMENT_ROUTE_PATHS,
  dynamicRouteFromPath,
  inferBasePathFromPathname,
  memoryTabFromPath,
  pathForMemoryTab,
  pathForAgentPanel,
  pathForClawCatalogEntry,
  pathForPluginSettings,
  pathForPluginCatalogEntry,
  pathForWorkboardBoard,
  pathForTerminalSession,
  terminalSessionIdFromPath,
  pluginSettingsIdFromPath,
  routeIdFromPath,
  routePageSpec,
  setPluginTabSlugs,
  type RouteId,
} from "./app-route-paths.ts";
import { createApplicationRouter, startApplicationRouter } from "./app-routes.ts";
import { createAgentSelectionCapability } from "./app/agent-selection.ts";
import type { ApplicationContext } from "./app/context.ts";
import { createApplicationGatewaySnapshot } from "./test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "./test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "./test-helpers/gateway-methods.ts";

const DYNAMIC_STARTUP_CASES = [
  ["plugins", pathForPluginCatalogEntry("calendar"), "?probe=1", "#catalog"],
  ["agents", pathForAgentPanel("team.writer", "tools"), "?probe=1", "#catalog"],
  ["dashboard", "/dashboard/main/01JSESSIONA", "?probe=1", "#dashboard"],
  ["chat", "/beam/0123456789ab", "", "#message"],
  ["workboard", pathForWorkboardBoard("ops.v2"), "?agent=main", "#queue"],
  ["memory", pathForMemoryTab("settings"), "?probe=1", "#memory-backend"],
  ["plugin-settings", pathForPluginSettings("@openclaw/calendar"), "?probe=1", "#configuration"],
] as const satisfies readonly (readonly [RouteId, string, string, string])[];

function createHistory(pathname: string, search = "", hash = "") {
  let location: RouteLocation = { pathname, search, hash };
  let listener: ((next: RouteLocation) => void) | undefined;
  const update = (next: RouteLocation) => {
    location = next;
  };
  const history = {
    location: () => location,
    push: vi.fn(update),
    replace: vi.fn(update),
    listen: (next: (location: RouteLocation) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    visit(next: RouteLocation) {
      update(next);
      listener?.(next);
    },
  } satisfies RouterHistory & { visit(next: RouteLocation): void };
  return history;
}

function createTestRouter(
  routeId: RouteId,
  pathname: string,
  basePath = "",
  search = "",
  hash = "",
) {
  const router = createApplicationRouter();
  const route = router.getRoute(routeId);
  if (!route) {
    throw new Error(`Route missing: ${routeId}`);
  }
  const { loader, component } = route;
  onTestFinished(() => {
    router.stop();
    route.loader = loader;
    route.component = component;
  });
  route.component = async () => ({ renderSolid: () => null });
  const history = createHistory(pathname, search, hash);
  const context = createStartupContext(basePath);
  return {
    router,
    route,
    history,
    context,
    start: () => startApplicationRouter(router, history, basePath, context),
  };
}

function createStartupContext(basePath = ""): ApplicationContext {
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      sessionKey: "agent:main:main",
    }),
  );
  return {
    basePath,
    gateway,
    settingsAgentSelection: createAgentSelectionCapability(
      gateway,
      { state: { agentsList: null }, subscribe: () => () => {} },
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    ),
  } as unknown as ApplicationContext;
}

it("defers a cold slug until hello and loads each tab at its real pathname", async () => {
  const {
    router,
    history,
    context: baseContext,
  } = createTestRouter("plugin", "/ui/reports", "/ui", "?p.range=week", "#latest");
  const replace = history.replace;
  history.push = replace;
  const gateway = createApplicationGateway(baseContext.gateway.snapshot);
  const context = { ...baseContext, gateway: gateway.gateway };
  setPluginTabSlugs();
  try {
    await startApplicationRouter(router, history, "/ui", context);
    expect(history.location().pathname).toBe("/ui/reports");
    expect(replace).not.toHaveBeenCalled();
    expect(router.getState().status).toBe("notFound");
    setPluginTabSlugs([{ pluginId: "fixture", id: "summary", slug: "reports" }]);
    await router.navigate("plugin", context, { history: "replace" }, history.location());
    expect(router.getState().matches[0]).toMatchObject({
      routeId: "plugin",
      location: history.location(),
      data: { pluginId: "fixture", id: "summary", params: { range: "week" } },
    });
    const tabs = [{ pluginId: "other-fixture", id: "replacement", slug: "reports" }];
    gateway.publish({
      ...context.gateway.snapshot,
      phase: "connected",
      hello: { ...gatewayHelloForMethods([]), controlUiTabs: tabs },
    });
    await vi.waitFor(() =>
      expect(router.getState().matches[0]?.data).toMatchObject({
        pluginId: "other-fixture",
        id: "replacement",
      }),
    );
    gateway.publish({ ...context.gateway.snapshot, phase: "stopped", hello: null });
    gateway.publish({
      ...context.gateway.snapshot,
      phase: "connected",
      hello: gatewayHelloForMethods([]),
    });
    await vi.waitFor(() => expect(router.getState().status).toBe("notFound"));
    expect(history.location().pathname).toBe("/ui/reports");
  } finally {
    setPluginTabSlugs();
  }
});

it("keeps share-route reservations aligned with every built-in path and alias", () => {
  const reservedRouteSegments = [
    ...new Set([
      "focus",
      "share",
      ...Object.values(CONTROL_UI_DOCUMENT_ROUTE_PATHS).map((path) => path.slice(1)),
      ...APP_ROUTE_IDS.flatMap((routeId) => {
        const definition = routePageSpec(routeId);
        return [definition.path, ...(definition.aliases ?? [])]
          .map((path) => path.split("/").find(Boolean))
          .filter((segment): segment is string => Boolean(segment));
      }),
    ]),
  ].toSorted();

  expect([...CONTROL_UI_RESERVED_ROUTE_SEGMENTS].toSorted()).toEqual(reservedRouteSegments);
  expect(reservedRouteSegments.every(isControlUiReservedRouteSegment)).toBe(true);
});

it("matches mixed-case deep links exactly like the uirouter path key", () => {
  // uirouter lowercases static path keys; a case-sensitive pre-gate would
  // rewrite /Usage to /chat before the router ever saw it.
  expect(routeIdFromPath("/Usage")).toBe("usage");
  expect(routeIdFromPath("/Settings/About")).toBe("about");
  expect(routeIdFromPath("/ui/Usage", "/ui")).toBe("usage");
});

it.each(DYNAMIC_STARTUP_CASES)(
  "loads %s once while publishing its real location",
  async (routeId, pathname, search, hash) => {
    const { router, route, history, start } = createTestRouter(routeId, pathname, "", search, hash);
    const initialLocation = history.location();
    const loader = vi.fn(async () => ({ routeId }));
    route.loader = loader;
    await start();
    expect(loader).toHaveBeenCalledOnce();
    expect(router.getState().matches[0]?.location).toEqual(initialLocation);
    expect(history.push).not.toHaveBeenCalled();
    expect(history.replace).not.toHaveBeenCalled();
  },
);

it("loads a later Activity history destination exactly once", async () => {
  const { route, history, start } = createTestRouter(
    "activity",
    "/activity/josh-12345678",
    "",
    "",
    "#first",
  );
  const loader = vi.fn<NonNullable<typeof route.loader>>(async () => ({}));
  route.loader = loader;
  await start();
  expect(loader).toHaveBeenCalledOnce();
  const location = { pathname: "/activity/mira-2ab34567", search: "", hash: "#second" };
  history.visit(location);
  await vi.waitFor(() => {
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1]?.[1].location).toEqual(location);
  });
});

it.each([
  ["/", "/chat", 1],
  ["/chat/main/01JSESSIONA", "/chat/main/01JSESSIONA", 2],
] as const)("keeps not-found startup state for %s", async (pathname, expectedPath, calls) => {
  const { router, route, history, start } = createTestRouter("chat", pathname);
  const loader = vi.fn(() => notFound({ routeId: "chat" }));
  route.loader = loader;
  await expect(start()).resolves.toBeUndefined();
  expect(loader).toHaveBeenCalledTimes(calls);
  expect(history.location()).toEqual({ pathname: expectedPath, search: "", hash: "" });
  expect(router.getState().status).toBe("notFound");
  expect(router.getState().location).toEqual(history.location());
  expect(router.getState().matches[0]).toMatchObject({
    routeId: "chat",
    status: "notFound",
    error: { type: "notFound", data: { routeId: "chat" } },
  });
});

it("still rejects non-not-found startup failures", async () => {
  const failure = new Error("chat loader failed");
  const { route, start } = createTestRouter("chat", "/chat");
  route.loader = () => {
    throw failure;
  };
  await expect(start()).rejects.toBe(failure);
});
it.each(["agent/child", ".", ".."])("rejects agent id %s", (id) => {
  expect(() => pathForAgentPanel(id)).toThrow("Invalid agent id");
});

it("normalizes an invalid panel once before the startup bridge", async () => {
  const {
    router,
    history,
    context: baseContext,
  } = createTestRouter("agents", "/settings/agents/main/unknown", "", "?probe=1", "#agents");
  const agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
    agents: [{ id: "main" }],
  };
  const context = {
    ...baseContext,
    agents: {
      state: { agentsList, agentsError: null },
      ensureList: () => Promise.resolve(agentsList),
    },
  } as unknown as ApplicationContext;

  await startApplicationRouter(router, history, "", context);

  expect(history.replace).toHaveBeenCalledOnce();
  expect(history.replace).toHaveBeenCalledWith({
    pathname: "/settings/agents/main",
    search: "?probe=1",
    hash: "#agents",
  });
  expect(history.push).not.toHaveBeenCalled();
  expect(history.location().pathname).toBe("/settings/agents/main");
});
it.each(["overview", "settings"] as const)("round-trips %s under a configured base path", (tab) => {
  const pathname = pathForMemoryTab(tab, "/ui");
  expect(memoryTabFromPath(pathname, "/ui")).toBe(tab);
  expect(routeIdFromPath(pathname, "/ui")).toBe("memory");
  expect(inferBasePathFromPathname(pathname)).toBe("/ui");
});

it.each(["/ui", "/portable/control"])(
  "retains %s when starting a catalog detail",
  async (basePath) => {
    const pathname = pathForPluginCatalogEntry("calendar", basePath);
    const inferredBase = inferBasePathFromPathname(pathname);
    expect(inferredBase).toBe(basePath);
    const { router, route, history, start } = createTestRouter(
      "plugins",
      pathname,
      inferredBase,
      "?probe=1",
      "#catalog",
    );
    route.loader = vi.fn(async () => null);
    await start();
    expect(router.getState().matches[0]?.routeId).toBe("plugins");
    expect(history.location()).toEqual({ pathname, search: "?probe=1", hash: "#catalog" });
    expect(history.replace).not.toHaveBeenCalled();
  },
);
it("round-trips encoded plugin ids under a configured base path", () => {
  const pathname = pathForPluginSettings("@openclaw/calendar", "/ui");
  expect(pathname).toBe("/ui/settings/plugins/%40openclaw%2Fcalendar");
  expect(pluginSettingsIdFromPath(pathname, "/ui")).toBe("@openclaw/calendar");
  expect(routeIdFromPath(pathname, "/ui")).toBe("plugin-settings");
  expect(inferBasePathFromPathname(pathname)).toBe("/ui");
});

it("keeps the retired discover path out of the plugin-id namespace", () => {
  expect(pluginSettingsIdFromPath("/settings/plugins/discover")).toBeNull();
  expect(routeIdFromPath("/settings/plugins/discover")).toBe("plugins");
  const reservedIdPath = pathForPluginSettings("discover");
  expect(reservedIdPath).toBe("/settings/plugins/%64iscover");
  expect(pluginSettingsIdFromPath(reservedIdPath)).toBe("discover");
  expect(routeIdFromPath(reservedIdPath)).toBe("plugin-settings");
});
it.each(["@openclaw/workflow-operator", "@community/travel-planner", "personal-claw"])(
  "round trips the public package identity %s",
  (packageName) => {
    const pathname = pathForClawCatalogEntry(packageName, "/ui");
    expect(pathname).toBe(`/ui/claws/packages/${encodeURIComponent(packageName)}`);
    expect(clawCatalogPackageNameFromPath(pathname, "/ui")).toBe(packageName);
    expect(routeIdFromPath(pathname, "/ui")).toBe("claws");
    expect(dynamicRouteFromPath(pathname, "/ui")).toEqual([
      "claws",
      "__openclawClawsPath",
      pathname,
    ]);
  },
);

it("preserves existing official detail links", () => {
  expect(clawCatalogPackageNameFromPath("/claws/workflow-operator")).toBe(
    "@openclaw/workflow-operator",
  );
});

it.each(["@maker/../private", "@Maker/claw", "../private", "@maker/claw/extra"])(
  "rejects invalid package identity %s",
  (packageName) => {
    expect(() => pathForClawCatalogEntry(packageName)).toThrow("Invalid Claw package name");
    expect(
      clawCatalogPackageNameFromPath(`/claws/packages/${encodeURIComponent(packageName)}`),
    ).toBeNull();
  },
);

it("resolves terminal paths under a mount", () => {
  const basePath = "/openclaw";
  expect(routeIdFromPath(`${basePath}/terminal`, basePath)).toBe("terminal");
  const path = pathForTerminalSession("pty:one ?#%", basePath);
  expect(path).toBe(`${basePath}/terminal/pty%3Aone%20%3F%23%25`);
  expect(terminalSessionIdFromPath(path, basePath)).toBe("pty:one ?#%");
  expect(routeIdFromPath(path, basePath)).toBe("terminal");
  expect(inferBasePathFromPathname(path)).toBe(basePath);
});

it.each([
  [agentRouteFromPath, "/settings/agents/agent%2Fchild", ""],
  [agentRouteFromPath, "/settings/agents/%", ""],
  [agentRouteFromPath, "/settings/agents/research/tools/extra", ""],
  [memoryTabFromPath, "/settings/memory//", ""],
  [memoryTabFromPath, "/settings/memory/unknown", ""],
  [memoryTabFromPath, "/settings/memory/dreams/extra", ""],
  [pluginSettingsIdFromPath, "/settings/plugins/calendar/extra", ""],
  [clawCatalogPackageNameFromPath, "/claws/@openclaw/workflow-operator/extra", ""],
  [clawCatalogPackageNameFromPath, "/claws/packages/@maker/travel-planner", ""],
  [clawCatalogPackageNameFromPath, "/claws/packages/%ZZ", ""],
  [terminalSessionIdFromPath, "/terminal/%ZZ", ""],
  [terminalSessionIdFromPath, "/other/terminal/id", "/openclaw"],
  [routeIdFromPath, "/settings/memory/unknown", ""],
  [routeIdFromPath, "/settings/memory/dreams/extra", ""],
  [routeIdFromPath, "/terminal/%ZZ", ""],
  [routeIdFromPath, "/other/terminal/id", "/openclaw"],
  [routeIdFromPath, "/agents", ""],
] as const)("rejects invalid route via %s: %s", (parse, path, base) => {
  expect(parse(path, base)).toBeNull();
});
it("never claims Gateway-owned plugin HTTP namespaces", () => {
  expect(APP_ROUTE_OFFLINE_PREFIXES).toContain("/chat/");
  expect(APP_ROUTE_OFFLINE_PREFIXES).not.toContain("/plugin/");
  expect(APP_ROUTE_OFFLINE_PREFIXES.some((prefix) => prefix.startsWith("/plugins"))).toBe(false);
});
