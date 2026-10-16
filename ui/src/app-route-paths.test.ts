// @vitest-environment node
import {
  CONTROL_UI_RESERVED_ROUTE_SEGMENTS,
  isControlUiReservedRouteSegment,
} from "@openclaw/session-url-contract";
import { notFound, type RouteLocation, type RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import {
  agentRouteFromPath,
  APP_ROUTE_IDS,
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
  {
    label: "agent panel",
    routeId: "agents",
    location: {
      pathname: pathForAgentPanel("team.writer", "tools"),
      search: "?probe=1",
      hash: "#catalog",
    },
  },
  {
    label: "dashboard session",
    routeId: "dashboard",
    location: {
      pathname: "/dashboard/main/01JSESSIONA",
      search: "?probe=1",
      hash: "#dashboard",
    },
  },
  {
    label: "Beam share",
    routeId: "chat",
    location: {
      pathname: "/beam/0123456789ab",
      search: "",
      hash: "#message",
    },
  },
  {
    label: "workboard board",
    routeId: "workboard",
    location: {
      pathname: pathForWorkboardBoard("ops.v2"),
      search: "?agent=main",
      hash: "#queue",
    },
  },
  {
    label: "Memory tab",
    routeId: "memory",
    location: {
      pathname: pathForMemoryTab("settings"),
      search: "?probe=1",
      hash: "#memory-backend",
    },
  },
  {
    label: "Plugin Settings detail",
    routeId: "plugin-settings",
    location: {
      pathname: pathForPluginSettings("@openclaw/calendar"),
      search: "?probe=1",
      hash: "#configuration",
    },
  },
] as const satisfies readonly {
  label: string;
  routeId: RouteId;
  location: RouteLocation;
}[];

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
    let location: RouteLocation = {
      pathname: "/ui/reports",
      search: "?p.range=week",
      hash: "#latest",
    };
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push: replace,
      replace,
      listen: () => () => {},
    };
    const router = createApplicationRouter();
    const baseContext = createStartupContext("/ui");
    const gateway = createApplicationGateway(baseContext.gateway.snapshot);
    const context = { ...baseContext, gateway: gateway.gateway };
    const route = router.getRoute("plugin")!;
    const originalComponent = route.component;
    route.component = async () => ({ render: () => null });
    setPluginTabSlugs();
    try {
      await startApplicationRouter(router, history, "/ui", context);
      expect(location.pathname).toBe("/ui/reports");
      expect(replace).not.toHaveBeenCalled();
      expect(router.getState().status).toBe("notFound");
      setPluginTabSlugs([
        { pluginId: "fixture", id: "summary", slug: "reports" },
        { pluginId: "fixture", id: "metrics", slug: "metrics" },
      ]);
      await router.navigate("plugin", context, { history: "replace" }, location);
      expect(router.getState().matches[0]).toMatchObject({
        routeId: "plugin",
        location,
        data: { pluginId: "fixture", id: "summary", params: { range: "week" } },
      });
      await router.navigate(
        "plugin",
        context,
        { history: "push" },
        { ...location, pathname: "/ui/metrics" },
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
      expect(location.pathname).toBe("/ui/metrics");
    } finally {
      router.stop();
      route.component = originalComponent;
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
    "loads the $label once while publishing its real location",
    async (testCase) => {
      const { routeId, location: initialLocation } = testCase;
      const basePath = "";
      let location: RouteLocation = { ...initialLocation };
      const push = vi.fn((next: RouteLocation) => {
        location = next;
      });
      const replace = vi.fn((next: RouteLocation) => {
        location = next;
      });
      const history: RouterHistory = {
        location: () => location,
        push,
        replace,
        listen: () => () => undefined,
      };
      const router = createApplicationRouter();
      const route = router.getRoute(routeId);
      if (!route) {
        throw new Error(`Route missing: ${routeId}`);
      }
      const loader = vi.fn(async () => ({ routeId }));
      const originalLoader = route.loader;
      const originalComponent = route.component;
      try {
        route.loader = loader;
        route.component = async () => ({ render: () => null });

        await startApplicationRouter(router, history, basePath, createStartupContext(basePath));

        expect(loader).toHaveBeenCalledOnce();
        expect(router.getState().matches[0]?.location).toEqual(initialLocation);
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
      } finally {
        router.stop();
        route.loader = originalLoader;
        route.component = originalComponent;
      }
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
      let location: RouteLocation = {
        pathname: firstPath,
        search: "",
        hash: "#first",
      };
      let historyListener: ((next: RouteLocation) => void) | undefined;
      const history: RouterHistory = {
        location: () => location,
        push: vi.fn((next: RouteLocation) => {
          location = next;
        }),
        replace: vi.fn((next: RouteLocation) => {
          location = next;
        }),
        listen: (listener) => {
          historyListener = listener;
          return () => {
            historyListener = undefined;
          };
        },
      };
      const router = createApplicationRouter();
      const route = router.getRoute(routeId);
      if (!route) {
        throw new Error(`Route missing: ${routeId}`);
      }
      const loader = vi.fn<NonNullable<typeof route.loader>>(async () => ({}));
      const originalLoader = route.loader;
      const originalComponent = route.component;
      try {
        route.loader = loader;
        route.component = async () => ({ render: () => null });

        await startApplicationRouter(router, history, "", createStartupContext());
        expect(loader).toHaveBeenCalledOnce();

        location = {
          pathname: nextPath,
          search: "",
          hash: "#second",
        };
        historyListener?.(location);

        await vi.waitFor(() => {
          expect(loader).toHaveBeenCalledTimes(2);
          expect(loader.mock.calls[1]?.[1].location).toEqual(location);
        });
      } finally {
        router.stop();
        route.loader = originalLoader;
        route.component = originalComponent;
      }
    },
  );

  it("keeps a loader not-found state without rejecting startup", async () => {
    let location: RouteLocation = { pathname: "/", search: "", hash: "" };
    const history: RouterHistory = {
      location: () => location,
      push: vi.fn(),
      replace: vi.fn((next: RouteLocation) => {
        location = next;
      }),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = () => notFound({ routeId: "chat" });
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", createStartupContext()),
      ).resolves.toBeUndefined();

      expect(location.pathname).toBe("/chat");
      expect(router.getState().status).toBe("notFound");
      expect(router.getState().matches[0]).toMatchObject({
        routeId: "chat",
        status: "notFound",
        error: { type: "notFound", data: { routeId: "chat" } },
      });
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });

  it("tolerates not-found from both dynamic startup navigations", async () => {
    const location: RouteLocation = {
      pathname: "/chat/main/01JSESSIONA",
      search: "",
      hash: "",
    };
    const history: RouterHistory = {
      location: () => location,
      push: vi.fn(),
      replace: vi.fn(),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const loader = vi.fn(() => notFound({ routeId: "chat" }));
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = loader;
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", createStartupContext()),
      ).resolves.toBeUndefined();

      expect(loader).toHaveBeenCalledTimes(2);
      expect(router.getState().status).toBe("notFound");
      expect(router.getState().location).toEqual(location);
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });

  it("still rejects non-not-found startup failures", async () => {
    const failure = new Error("chat loader failed");
    const history: RouterHistory = {
      location: () => ({ pathname: "/chat", search: "", hash: "" }),
      push: vi.fn(),
      replace: vi.fn(),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = () => {
        throw failure;
      };
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", createStartupContext()),
      ).rejects.toBe(failure);
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
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
    let location: RouteLocation = {
      pathname: "/settings/agents/main/unknown",
      search: "?probe=1",
      hash: "#agents",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const agentsRoute = router.getRoute("agents");
    if (!agentsRoute) {
      throw new Error("Agents route missing");
    }
    agentsRoute.component = async () => ({ render: () => null });
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

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({
      pathname: "/settings/agents/main",
      search: "?probe=1",
      hash: "#agents",
    });
    expect(push).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/settings/agents/main");
    router.stop();
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
  it("uses a public package slug and restores its official package identity", () => {
    const pathname = pathForClawCatalogEntry("@openclaw/workflow-operator", "/ui");
    expect(pathname).toBe("/ui/agents/claws/workflow-operator");
    expect(clawCatalogPackageNameFromPath(pathname, "/ui")).toBe("@openclaw/workflow-operator");
    expect(routeIdFromPath(pathname, "/ui")).toBe("claws");
    expect(dynamicRouteFromPath(pathname, "/ui")).toEqual([
      "claws",
      "__openclawClawsPath",
      pathname,
    ]);
  });

  it("rejects malformed or non-OpenClaw package routes", () => {
    expect(() => pathForClawCatalogEntry("@community/travel-planner")).toThrow(
      "Only official Claws",
    );
    expect(clawCatalogPackageNameFromPath("/agents/claws/@openclaw/workflow-operator")).toBeNull();
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
