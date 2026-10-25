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

function createHistory(url: string) {
  const { pathname, search, hash } = new URL(url, "https://ui.example");
  let location: RouteLocation = { pathname, search, hash };
  let listener: ((next: RouteLocation) => void) | undefined;
  const update = (next: RouteLocation) => {
    location = next;
  };
  return {
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
}

function createTestRouter(routeId: RouteId, url: string, basePath = "") {
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
  const history = createHistory(url);
  const { gateway, publish } = createApplicationGateway(
    createApplicationGatewaySnapshot({ sessionKey: "agent:main:main" }),
  );
  const context = {
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
  return {
    router,
    route,
    history,
    context,
    publish,
    start: () => startApplicationRouter(router, history, basePath, context),
  };
}

it("defers a cold slug until hello and loads each tab at its real pathname", async () => {
  const { router, history, context, publish, start } = createTestRouter(
    "plugin",
    "/ui/reports?p.range=week#latest",
    "/ui",
  );
  const replace = history.replace;
  history.push = replace;
  setPluginTabSlugs();
  onTestFinished(() => setPluginTabSlugs());
  await start();
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
  const connect = (hello: ReturnType<typeof gatewayHelloForMethods>) =>
    publish({
      ...context.gateway.snapshot,
      phase: "connected",
      hello,
    });
  connect({ ...gatewayHelloForMethods([]), controlUiTabs: tabs });
  await vi.waitFor(() =>
    expect(router.getState().matches[0]?.data).toMatchObject({
      pluginId: "other-fixture",
      id: "replacement",
    }),
  );
  publish({ ...context.gateway.snapshot, phase: "stopped", hello: null });
  connect(gatewayHelloForMethods([]));
  await vi.waitFor(() => expect(router.getState().status).toBe("notFound"));
  expect(history.location().pathname).toBe("/ui/reports");
});

it("keeps share-route reservations aligned with every built-in path and alias", () => {
  const paths = APP_ROUTE_IDS.flatMap((id) => {
    const { path, aliases = [] } = routePageSpec(id);
    const routePaths: string[] = [path];
    return routePaths.concat(aliases);
  }).concat("focus", "share", Object.values(CONTROL_UI_DOCUMENT_ROUTE_PATHS));
  const reservedRouteSegments = [
    ...new Set(
      paths
        .map((path) => path.split("/").find(Boolean))
        .filter((segment): segment is string => Boolean(segment)),
    ),
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

it("loads a dynamic share once while publishing its real location", async () => {
  const { router, route, history, start } = createTestRouter("chat", "/beam/0123456789ab#message");
  const initialLocation = history.location();
  const loader = vi.fn(async () => ({}));
  route.loader = loader;
  await start();
  expect(loader).toHaveBeenCalledOnce();
  expect(router.getState().matches[0]?.location).toEqual(initialLocation);
  expect(history.push).not.toHaveBeenCalled();
  expect(history.replace).not.toHaveBeenCalled();
});

it("loads a later Activity history destination exactly once", async () => {
  const { router, route, history, start } = createTestRouter(
    "activity",
    "/activity/josh-12345678#first",
  );
  const loader = vi.fn<NonNullable<typeof route.loader>>(async () => ({}));
  route.loader = loader;
  await start();
  expect(loader).toHaveBeenCalledOnce();
  const location = { pathname: "/activity/mira-2ab34567", search: "", hash: "#second" };
  history.visit(location);
  await vi.waitFor(() => {
    expect(loader).toHaveBeenCalledTimes(2);
    expect(router.getState().matches[0]?.location).toEqual(location);
  });
});

it.each([
  ["/", "/chat"],
  ["/chat/main/01JSESSIONA", "/chat/main/01JSESSIONA"],
] as const)("keeps not-found startup state for %s", async (pathname, expectedPath) => {
  const { router, route, history, start } = createTestRouter("chat", pathname);
  route.loader = () => notFound({ routeId: "chat" });
  await expect(start()).resolves.toBeUndefined();
  expect(history.location()).toEqual({ pathname: expectedPath, search: "", hash: "" });
  expect(router.getState().status).toBe("notFound");
  expect(router.getState().location).toEqual(history.location());
  expect(router.getState().matches[0]?.error).toEqual({
    type: "notFound",
    data: { routeId: "chat" },
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
  const { route, history, start } = createTestRouter(
    "agents",
    "/settings/agents/main/unknown?probe=1#agents",
  );
  route.loader = async () => null;
  await start();

  expect(history.replace).toHaveBeenCalledOnce();
  expect(history.location()).toEqual({
    pathname: "/settings/agents/main",
    search: "?probe=1",
    hash: "#agents",
  });
  expect(history.push).not.toHaveBeenCalled();
});
it.each(["overview", "settings"] as const)("round-trips %s under a configured base path", (tab) => {
  const pathname = pathForMemoryTab(tab, "/ui");
  expect(memoryTabFromPath(pathname, "/ui")).toBe(tab);
  expect(routeIdFromPath(pathname, "/ui")).toBe("memory");
  expect(inferBasePathFromPathname(pathname)).toBe("/ui");
  expect(dynamicRouteFromPath(pathname, "/ui")?.[0]).toBe(
    tab === "overview" ? undefined : "memory",
  );
});

it.each(["/ui", "/portable/control"])("starts catalog detail under %s", async (basePath) => {
  const pathname = pathForPluginCatalogEntry("calendar", basePath);
  const inferredBase = inferBasePathFromPathname(pathname);
  expect(inferredBase).toBe(basePath);
  const { router, route, history, start } = createTestRouter(
    "plugins",
    `${pathname}?probe=1#catalog`,
    inferredBase,
  );
  route.loader = vi.fn(async () => null);
  await start();
  expect(router.getState().matches[0]?.routeId).toBe("plugins");
  expect(history.location()).toEqual({ pathname, search: "?probe=1", hash: "#catalog" });
  expect(history.replace).not.toHaveBeenCalled();
});
it("round-trips encoded plugin ids under a configured base path", () => {
  const pathname = pathForPluginSettings("@openclaw/calendar", "/ui");
  expect(pathname).toBe("/ui/settings/plugins/%40openclaw%2Fcalendar");
  expect(pluginSettingsIdFromPath(pathname, "/ui")).toBe("@openclaw/calendar");
  expect(routeIdFromPath(pathname, "/ui")).toBe("plugin-settings");
  expect(dynamicRouteFromPath(pathname, "/ui")?.[0]).toBe("plugin-settings");
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
it.each(["@community/travel-planner", "personal-claw"])("round-trips %s", (name) => {
  const pathname = pathForClawCatalogEntry(name, "/ui");
  expect(pathname).toBe(`/ui/claws/packages/${encodeURIComponent(name)}`);
  expect(clawCatalogPackageNameFromPath(pathname, "/ui")).toBe(name);
  expect(routeIdFromPath(pathname, "/ui")).toBe("claws");
  expect(dynamicRouteFromPath(pathname, "/ui")?.[0]).toBe("claws");
});

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
  [pluginSettingsIdFromPath, "/settings/plugins/calendar/extra", ""],
  [clawCatalogPackageNameFromPath, "/claws/@openclaw/workflow-operator/extra", ""],
  [clawCatalogPackageNameFromPath, "/claws/packages/@maker/travel-planner", ""],
  [clawCatalogPackageNameFromPath, "/claws/packages/%ZZ", ""],
  [terminalSessionIdFromPath, "/other/terminal/id", "/openclaw"],
  [routeIdFromPath, "/settings/memory/unknown", ""],
  [routeIdFromPath, "/terminal/%ZZ", ""],
  [routeIdFromPath, "/other/terminal/id", "/openclaw"],
] as const)("rejects invalid route via %s: %s", (parse, path, base) => {
  expect(parse(path, base)).toBeNull();
});
it("never claims Gateway-owned plugin HTTP namespaces", () => {
  expect(APP_ROUTE_OFFLINE_PREFIXES).toContain("/chat/");
  expect(APP_ROUTE_OFFLINE_PREFIXES).not.toContain("/plugin/");
  expect(APP_ROUTE_OFFLINE_PREFIXES.some((prefix) => prefix.startsWith("/plugins"))).toBe(false);
});
