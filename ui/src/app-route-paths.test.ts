// @vitest-environment node
import {
  CONTROL_UI_RESERVED_ROUTE_SEGMENTS,
  isControlUiReservedRouteSegment,
} from "@openclaw/session-url-contract";
import { notFound, type RouteLocation, type RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  pathForWorkboardBoard,
  pathForTerminalSession,
  terminalSessionIdFromPath,
  pluginSettingsIdFromPath,
  routeIdFromPath,
  routePageSpec,
  setPluginTabSlugs,
  type RouteId,
  type MemoryRouteTab,
} from "./app-route-paths.ts";
import { createApplicationRouter, startApplicationRouter } from "./app-routes.ts";
import { createAgentSelectionCapability } from "./app/agent-selection.ts";
import type { ApplicationContext } from "./app/context.ts";
import { createApplicationGateway } from "./test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "./test-helpers/gateway-methods.ts";

const DYNAMIC_STARTUP_CASES = [
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

function createTestRouter(routeId: RouteId) {
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
  return { router, route };
}

function createStartupContext(basePath = ""): ApplicationContext {
  const { gateway } = createApplicationGateway({
    phase: "stopped",
    client: null,
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  });
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

describe("Dynamic route startup bridge", () => {
  it("defers a cold slug until hello and loads each tab at its real pathname", async () => {
    const history = createHistory("/ui/reports", "?p.range=week", "#latest");
    const replace = history.replace;
    history.push = replace;
    const { router } = createTestRouter("plugin");
    const baseContext = createStartupContext("/ui");
    const gateway = createApplicationGateway(baseContext.gateway.snapshot);
    const context = { ...baseContext, gateway: gateway.gateway };
    setPluginTabSlugs();
    try {
      await startApplicationRouter(router, history, "/ui", context);
      expect(history.location().pathname).toBe("/ui/reports");
      expect(replace).not.toHaveBeenCalled();
      expect(router.getState().status).toBe("notFound");
      setPluginTabSlugs([
        { pluginId: "fixture", id: "summary", slug: "reports" },
        { pluginId: "fixture", id: "metrics", slug: "metrics" },
      ]);
      await router.navigate("plugin", context, { history: "replace" }, history.location());
      expect(router.getState().matches[0]).toMatchObject({
        routeId: "plugin",
        location: history.location(),
        data: { pluginId: "fixture", id: "summary", params: { range: "week" } },
      });
      await router.navigate(
        "plugin",
        context,
        { history: "push" },
        { ...history.location(), pathname: "/ui/metrics" },
      );
      expect(router.getState().matches[0]?.data).toMatchObject({
        pluginId: "fixture",
        id: "metrics",
      });
      const tabs = [
        { pluginId: "other-fixture", id: "replacement", label: "Metrics", slug: "metrics" },
      ];
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
      expect(history.location().pathname).toBe("/ui/metrics");
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
      const history = createHistory(pathname, search, hash);
      const initialLocation = history.location();
      const { router, route } = createTestRouter(routeId);
      const loader = vi.fn(async () => ({ routeId }));
      route.loader = loader;
      await startApplicationRouter(router, history, "", createStartupContext());
      expect(loader).toHaveBeenCalledOnce();
      expect(router.getState().matches[0]?.location).toEqual(initialLocation);
      expect(history.push).not.toHaveBeenCalled();
      expect(history.replace).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      routeId: "activity",
      firstPath: "/activity/josh-12345678",
      nextPath: "/activity/mira-2ab34567",
    },
  ] as const)(
    "loads a later $routeId history destination exactly once",
    async ({ routeId, firstPath, nextPath }) => {
      const history = createHistory(firstPath, "", "#first");
      const { router, route } = createTestRouter(routeId);
      const loader = vi.fn<NonNullable<typeof route.loader>>(async () => ({}));
      route.loader = loader;
      await startApplicationRouter(router, history, "", createStartupContext());
      expect(loader).toHaveBeenCalledOnce();
      const location = { pathname: nextPath, search: "", hash: "#second" };
      history.visit(location);
      await vi.waitFor(() => {
        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader.mock.calls[1]?.[1].location).toEqual(location);
      });
    },
  );

  it("keeps a loader not-found state without rejecting startup", async () => {
    const history = createHistory("/");
    const { router, route } = createTestRouter("chat");
    route.loader = () => notFound({ routeId: "chat" });
    await expect(
      startApplicationRouter(router, history, "", createStartupContext()),
    ).resolves.toBeUndefined();
    expect(history.location().pathname).toBe("/chat");
    expect(router.getState().status).toBe("notFound");
    expect(router.getState().matches[0]).toMatchObject({
      routeId: "chat",
      status: "notFound",
      error: { type: "notFound", data: { routeId: "chat" } },
    });
  });

  it("tolerates not-found from both dynamic startup navigations", async () => {
    const history = createHistory("/chat/main/01JSESSIONA");
    const location = history.location();
    const { router, route } = createTestRouter("chat");
    const loader = vi.fn(() => notFound({ routeId: "chat" }));
    route.loader = loader;
    await expect(
      startApplicationRouter(router, history, "", createStartupContext()),
    ).resolves.toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(router.getState().status).toBe("notFound");
    expect(router.getState().location).toEqual(location);
  });

  it("still rejects non-not-found startup failures", async () => {
    const failure = new Error("chat loader failed");
    const history = createHistory("/chat");
    const { router, route } = createTestRouter("chat");
    route.loader = () => {
      throw failure;
    };
    await expect(startApplicationRouter(router, history, "", createStartupContext())).rejects.toBe(
      failure,
    );
  });
});

describe("Agent panel route paths", () => {
  it("rejects malformed, slash-containing, and nested agent paths", () => {
    expect(() => pathForAgentPanel("agent/child")).toThrow("Invalid agent id");
    expect(() => pathForAgentPanel(".")).toThrow("Invalid agent id");
    expect(() => pathForAgentPanel("..")).toThrow("Invalid agent id");
    expect(agentRouteFromPath("/settings/agents/agent%2Fchild")).toBeNull();
    expect(agentRouteFromPath("/settings/agents/%")).toBeNull();
    expect(agentRouteFromPath("/settings/agents/research/tools/extra")).toBeNull();
  });

  it("normalizes an invalid panel once before the startup bridge", async () => {
    const history = createHistory("/settings/agents/main/unknown", "?probe=1", "#agents");
    const { router } = createTestRouter("agents");
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
      agents: [{ id: "main" }],
    };
    const context = {
      ...createStartupContext(),
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
});

describe("Memory tab route paths", () => {
  it.each(["overview", "settings"] as const)(
    "round-trips %s under a configured base path",
    (tab: MemoryRouteTab) => {
      const pathname = pathForMemoryTab(tab, "/ui");
      expect(memoryTabFromPath(pathname, "/ui")).toBe(tab);
      expect(routeIdFromPath(pathname, "/ui")).toBe("memory");
      expect(inferBasePathFromPathname(pathname)).toBe("/ui");
    },
  );

  it("rejects unknown and nested Memory tab segments", () => {
    expect(memoryTabFromPath("/settings/memory//")).toBeNull();
    expect(memoryTabFromPath("/settings/memory/unknown")).toBeNull();
    expect(memoryTabFromPath("/settings/memory/dreams/extra")).toBeNull();
    expect(routeIdFromPath("/settings/memory/unknown")).toBeNull();
    expect(routeIdFromPath("/settings/memory/dreams/extra")).toBeNull();
  });
});

describe("Plugin Settings route paths", () => {
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
    expect(pluginSettingsIdFromPath("/settings/plugins/calendar/extra")).toBeNull();
  });
});

describe("Claw detail route paths", () => {
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

  it("rejects malformed or unencoded package routes", () => {
    expect(clawCatalogPackageNameFromPath("/claws/@openclaw/workflow-operator/extra")).toBeNull();
    expect(clawCatalogPackageNameFromPath("/claws/packages/@maker/travel-planner")).toBeNull();
    expect(clawCatalogPackageNameFromPath("/claws/packages/%ZZ")).toBeNull();
  });

  it("does not expose the retired Agents overview route", () => {
    expect(routeIdFromPath("/agents")).toBeNull();
  });
});

describe("terminal route paths", () => {
  it.each(["/openclaw"])("resolves terminal paths under %s", (basePath) => {
    expect(routeIdFromPath(`${basePath}/terminal`, basePath)).toBe("terminal");
    const path = pathForTerminalSession("pty:one ?#%", basePath);
    expect(path).toBe(`${basePath}/terminal/pty%3Aone%20%3F%23%25`);
    expect(terminalSessionIdFromPath(path, basePath)).toBe("pty:one ?#%");
    expect(routeIdFromPath(path, basePath)).toBe("terminal");
    expect(inferBasePathFromPathname(path)).toBe(basePath);
  });

  it.each(["/terminal/%ZZ"])("rejects invalid terminal identity %s", (path) => {
    expect(terminalSessionIdFromPath(path)).toBeNull();
    expect(routeIdFromPath(path)).toBeNull();
  });

  it("does not consume a different mount's terminal identity", () => {
    expect(terminalSessionIdFromPath("/other/terminal/id", "/openclaw")).toBeNull();
    expect(routeIdFromPath("/other/terminal/id", "/openclaw")).toBeNull();
  });
});

describe("offline route admission", () => {
  it("never claims Gateway-owned plugin HTTP namespaces", () => {
    expect(APP_ROUTE_OFFLINE_PREFIXES).toContain("/chat/");
    expect(APP_ROUTE_OFFLINE_PREFIXES).not.toContain("/plugin/");
    expect(APP_ROUTE_OFFLINE_PREFIXES.some((prefix) => prefix.startsWith("/plugins"))).toBe(false);
  });
});
