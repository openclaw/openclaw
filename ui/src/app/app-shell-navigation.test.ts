/* @vitest-environment jsdom */

import { createRouter, definePage, type RouteRedirect } from "@openclaw/uirouter";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { isRouteId, locationForRoute, routePageSpec, type RouteId } from "../app-route-paths.ts";
import { filterCommandPaletteItems } from "../components/command-palette-catalog-search.ts";
import { pages as configPages } from "../pages/config/route.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { ShellNavigationOwner, type ShellNavigationHost } from "./app-shell-navigation.ts";
import { createBrowserHistory } from "./browser.ts";
import type { ApplicationContext } from "./context.ts";

it.each(["palette", "/settings/general", "/config"])(
  "round-trips %s to workspace",
  async (entry) => {
    const workspace = { pathname: "/chat/main", search: "?panel=files", hash: "#message-42" };
    const original: [state: unknown, url: string] = [window.history.state, window.location.href];
    onTestFinished(() => window.history.replaceState(original[0], "", original[1]));
    window.history.replaceState({}, "", "/chat");
    const history = createBrowserHistory();
    const router = createRouter<RouteId, ApplicationContext, unknown, RouteRedirect>({
      routes: [
        ...configPages.filter((page) => page.id === "config"),
        ...(["chat", "appearance", "model-providers"] as const).map((id) =>
          definePage<RouteId, ApplicationContext, unknown, RouteRedirect>({
            ...routePageSpec(id),
            component: async () => ({ renderSolid: () => null }),
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
        const target = { ...locationForRoute(routeId, ""), ...options };
        navigation = router.navigate(routeId, context, { history: "push" }, target);
      },
    } as ApplicationContext;
    const shell = new ShellNavigationOwner({
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
    });
    const unsubscribe = router.subscribe((state) =>
      shell.updateRouteState(selectShellRouteState(state)),
    );
    onTestFinished(() => {
      unsubscribe();
      router.stop();
    });
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
      assert(routeId && isRouteId(routeId), "Settings palette action is missing");
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
    expect(history.location()).toEqual(workspace);
    expect(router.getState().matches[0]?.routeId).toBe("chat");
  },
);

function titledSessionNavigation(face: "chat" | "dashboard") {
  const key = "agent:main:dashboard:12345678-1234-4234-8234-123456789abc";
  const location = {
    pathname: `/control/${face}/main/old-name-123456781234`,
    search: "?panel=files",
    hash: "#message-42",
  };
  const original = window.location.href;
  window.history.replaceState({}, "", `${location.pathname}${location.search}${location.hash}`);
  onTestFinished(() => window.history.replaceState({}, "", original));
  const replace = vi.fn();
  const context = {
    basePath: "/control",
    gateway: { snapshot: { phase: "connected", client: {}, hello: {} } },
    sessions: {
      state: { result: null },
      presentation: { result: { sessions: [{ key, displayName: "Updated session name" }] } },
    },
    replace,
  } as unknown as ApplicationContext;
  const host: ShellNavigationHost = {
    context,
    activeSessionKey: key,
    routeState: {
      routeId: face,
      location,
      committedRouteId: face,
      committedLocation: location,
      committedSessionKey: key,
    },
    lastWorkspaceLocation: null,
    custodianMinimizeRequestId: 0,
    lastConcreteRouteId: face,
    didConsiderNativeRouteRestore: true,
    settingsSearchQuery: "",
    closeNavDrawer: vi.fn(),
    ensureAgentsList: vi.fn(),
  };
  return { host, replace, location, navigation: new ShellNavigationOwner(host) };
}

it.each(["chat", "dashboard"] as const)(
  "keeps the base path, %s face, ID length, query and message anchor when renaming",
  (face) => {
    const { navigation, replace } = titledSessionNavigation(face);
    navigation.synchronizeSessionUrl();
    expect(replace).toHaveBeenCalledExactlyOnceWith(face, {
      pathname: `/control/${face}/main/updated-session-name-123456781234`,
      search: "?panel=files",
      hash: "#message-42",
    });
  },
);

it.each(["pending route", "pending identity", "new address", "other page"] as const)(
  "does not let title publications replace a %s",
  (mode) => {
    const { host, navigation, replace, location } = titledSessionNavigation("chat");
    if (mode === "pending route") {
      host.routeState = { ...host.routeState, location: { ...location, pathname: "/chat/other" } };
    } else if (mode === "pending identity") {
      host.routeState = { ...host.routeState, sessionUrlPending: true };
    } else if (mode === "new address") {
      window.history.pushState({}, "", "/settings");
    } else {
      host.routeState = { ...host.routeState, routeId: "activity" };
    }
    navigation.synchronizeSessionUrl();
    expect(replace).not.toHaveBeenCalled();
  },
);
