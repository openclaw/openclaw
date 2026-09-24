/* @vitest-environment jsdom */

import {
  createRouter,
  definePage,
  type RouteRedirect,
  type RouterHistory,
} from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { isRouteId, locationForRoute, routePageSpec, type RouteId } from "../app-route-paths.ts";
import { filterCommandPaletteItems } from "../components/command-palette-catalog-search.ts";
import { pages as configPages } from "../pages/config/route.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { ShellNavigationOwner, type ShellNavigationHost } from "./app-shell-navigation.ts";
import type { ApplicationContext } from "./context.ts";

describe("Settings return navigation", () => {
  it.each(["palette", "/settings/general", "/config"])(
    "returns to the complete workspace URL after entering Settings through %s",
    async (entry) => {
      const workspace = {
        pathname: "/chat/main",
        search: "?panel=files",
        hash: "#message-42",
      };
      let location = { pathname: "/chat", search: "", hash: "" };
      const history: RouterHistory = {
        location: () => location,
        push: (next) => {
          location = next;
        },
        replace: (next) => {
          location = next;
        },
        listen: () => () => undefined,
      };
      const router = createRouter<RouteId, ApplicationContext, unknown, RouteRedirect>({
        routes: [
          ...configPages.filter((page) => page.id === "config"),
          ...(["chat", "appearance", "model-providers"] as const).map((id) =>
            definePage<RouteId, ApplicationContext, unknown, RouteRedirect>({
              ...routePageSpec(id),
              component: async () => ({ render: () => null }),
            }),
          ),
        ],
      });
      let navigation: Promise<void> | undefined;
      const context = {
        basePath: "",
        gateway: { snapshot: { phase: "connected" } },
        chatSubmissions: {},
        navigate: (routeId, options) => {
          navigation = router.navigate(
            routeId,
            context,
            { history: "push" },
            {
              ...locationForRoute(routeId, ""),
              ...options,
            },
          );
        },
      } as ApplicationContext;
      const host: ShellNavigationHost = {
        context,
        activeSessionKey: "",
        routeState: {},
        lastWorkspaceLocation: null,
        custodianMinimizeRequestId: 0,
        lastConcreteRouteId: undefined,
        didConsiderNativeRouteRestore: false,
        settingsSearchQuery: "",
        closeNavDrawer: vi.fn(),
        ensureAgentsList: vi.fn(),
      };
      const shell = new ShellNavigationOwner(host);
      const unsubscribe = router.subscribe(() => {
        shell.updateRouteState(selectShellRouteState(router.getState()));
      });
      try {
        await router.start(history, "", context);
        await router.navigate("chat", context, { history: "replace" }, workspace);
        if (entry === "palette") {
          const item = filterCommandPaletteItems({
            query: "Settings",
            includeSlashCommands: false,
            sessionItems: [],
            catalogItems: [],
            desktopAvailable: false,
            custodianAvailable: false,
          })[0];
          const routeId = item?.action.slice(4);
          if (!routeId || !isRouteId(routeId)) {
            throw new Error("Settings palette action is missing");
          }
          shell.navigate(routeId);
          await navigation;
        } else {
          await router.navigateLocation({ pathname: entry, search: "", hash: "" }, context);
        }
        expect(router.getState().matches[0]?.routeId).toBe("appearance");
        shell.navigate("model-providers");
        await navigation;

        shell.exitSettings();
        await navigation;

        expect(location).toEqual(workspace);
        expect(router.getState().matches[0]?.routeId).toBe("chat");
      } finally {
        unsubscribe();
        router.stop();
      }
    },
  );
});
