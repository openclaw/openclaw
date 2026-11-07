import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../src/shared/deferred.ts";
import {
  APP_ROUTE_IDS,
  pathForRoute,
  routeIdFromPath,
  sameRouteLocation,
} from "./app-route-paths.ts";
import { createApplicationRouter, startApplicationRouter } from "./app-routes.ts";
import type { ApplicationContext } from "./app/context.ts";

it.each([
  ["", "appearance", "?section=__appearance__", "#settings-language"],
  ["#settings-general-model", "model-providers", "", "#settings-model-behavior"],
] as const)(
  "navigates General %s directly to its live destination",
  async (hash, target, search, targetHash) => {
    const router = createApplicationRouter();
    const destination = createDeferredCore<{ renderSolid: () => null }>();
    const page = router.getRoute(target)!;
    const component = vi.spyOn(page, "component").mockReturnValue(destination.promise);
    const loader = vi.spyOn(page, "loader").mockReturnValue(undefined);
    // SAFETY: These navigation-only fixtures replace the destination loader and component.
    const context = { basePath: "/ui" } as ApplicationContext;
    const navigation = router.navigate("config", context, undefined, {
      pathname: "/ui/settings/general",
      search: "?section=env",
      hash,
    });
    try {
      expect(router.getState().pendingMatches[0]?.routeId).toBe(target);
      expect(router.getState().location).toEqual({
        pathname: pathForRoute(target, "/ui"),
        search,
        hash: targetHash,
      });
    } finally {
      destination.resolve({ renderSolid: () => null });
      await navigation;
      router.stop();
      component.mockRestore();
      loader.mockRestore();
    }
  },
);

// Page definitions derive path/aliases from the route table via routePageSpec,
// so router matching cannot disagree with routeIdFromPath/base-path inference
// about a registered page. This guards the remaining seam: every table id must
// be registered with the router exactly once, and no page may reintroduce
// hand-written paths that shadow the table.
describe("application router registration", () => {
  const router = createApplicationRouter();

  it("registers every route id exactly once", () => {
    const routeIds = router.routes.map((route) => route.id);
    expect([...routeIds].toSorted()).toEqual([...APP_ROUTE_IDS].toSorted());
  });

  it("serves the table's canonical paths and aliases", () => {
    for (const route of router.routes) {
      expect(route.path, `path for route "${route.id}"`).toBe(pathForRoute(route.id));
      expect(router.routeIdFromPath(route.path), `registered path "${route.path}"`).toBe(route.id);
      for (const alias of route.aliases ?? []) {
        expect(routeIdFromPath(alias, ""), `alias "${alias}"`).toBe(route.id);
      }
    }
  });

  it("leaves the retired Tasks workspace URL unmatched", () => {
    expect(router.routeIdFromPath("/tasks")).toBeNull();
    expect(routeIdFromPath("/tasks")).toBeNull();
    expect(routeIdFromPath("/control/tasks", "/control")).toBeNull();
  });

  it("replaces the Agents overview with Templates while keeping per-agent settings", () => {
    expect(routeIdFromPath("/agents")).toBeNull();
    expect(routeIdFromPath("/agents/templates/workflow-operator")).toBeNull();
    expect(routeIdFromPath("/templates")).toBe("templates");
    expect(routeIdFromPath("/templates/workflow-operator")).toBe("templates");
    expect(routeIdFromPath("/settings/agents/research")).toBe("agents");
    expect(routeIdFromPath("/settings/agents/research/tools")).toBe("agents");
  });
});

it("compares optional route locations by pathname, search, and hash", () => {
  const location = { pathname: "/systems", search: "?machine=one", hash: "#desktop" };
  expect(sameRouteLocation(undefined, undefined)).toBe(true);
  expect(sameRouteLocation(undefined, location)).toBe(false);
  expect(sameRouteLocation(location, undefined)).toBe(false);
  expect(sameRouteLocation(location, { ...location })).toBe(true);
  for (const key of ["pathname", "search", "hash"] as const) {
    expect(sameRouteLocation(location, { ...location, [key]: "changed" })).toBe(false);
  }
});

it("prepares a cold page's selected language before returning its renderer", async () => {
  vi.resetModules();
  const { en } = await import("./i18n/locales/en.ts");
  const { i18n } = await import("./i18n/lib/translate.ts");
  const { createLazyLocaleCatalog } = await import("./i18n/lib/lazy-catalog.ts");
  const { createDeferred } = await import("../../test/helpers/promise.js");
  const { createApplicationRouter: createRouter } = await import("./app-routes.ts");
  expect(en.searchPage).toEqual({});
  const page = createDeferred<{ default: { searchPage: { queryDefault: string } } }>();
  const loadPage = vi.fn(() => page.promise);
  const loadUnopened = vi.fn();
  i18n.registerTranslation(
    "de",
    createLazyLocaleCatalog(structuredClone(en), {
      searchPage: loadPage,
      configHints: loadUnopened,
    }),
  );
  await i18n.setLocale("de");
  expect(loadPage).not.toHaveBeenCalled();
  let settled = false;
  const loading = Promise.resolve(createRouter().getRoute("search")!.component()).then((module) => {
    settled = true;
    return module;
  });
  try {
    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(loadUnopened).not.toHaveBeenCalled();
    page.resolve({ default: { searchPage: { queryDefault: "OpenClaw Dokumentation" } } });
    await loading;
    expect(i18n.t("searchPage.queryDefault")).toBe("OpenClaw Dokumentation");
  } finally {
    page.resolve({ default: { searchPage: { queryDefault: "OpenClaw Dokumentation" } } });
    await loading;
    await i18n.setLocale("en");
  }
});

it.each([
  ["/ui/settings?keep=1#anchor", "/ui/chat?keep=1#anchor"],
  ["/ui/communications?section=%20channels%20&drop=1#anchor", "/ui/settings/channels#anchor"],
  ["/ui/automation?section=plugins&drop=1#anchor", "/ui/settings/plugins?tab=advanced#anchor"],
])("canonicalizes bookmark and history entry %s", async (requestedUrl, expectedUrl) => {
  const location = (url: string) => {
    const parsed = new URL(url, "https://control.test");
    return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  };
  let current = location(requestedUrl);
  let pop: (next: typeof current) => void = () => {};
  const replace = vi.fn((next: typeof current) => {
    current = next;
  });
  const history = {
    location: () => current,
    replace,
    push: vi.fn((next: typeof current) => {
      current = next;
    }),
    listen: (listener: typeof pop) => {
      pop = listener;
      return () => {};
    },
  };
  const router = createApplicationRouter();
  // SAFETY: The fixture substitutes route loading; only the router/history boundary runs.
  const context = {
    basePath: "/ui",
    gateway: { snapshot: { phase: "disconnected", hello: null }, subscribe: () => () => {} },
  } as unknown as ApplicationContext;
  const mocks = router.routes.flatMap((page) => [
    vi.spyOn(page, "component").mockResolvedValue({ renderSolid: () => null }),
    ...(page.loader ? [vi.spyOn(page, "loader").mockReturnValue(undefined)] : []),
    ...(page.loaderDeps ? [vi.spyOn(page, "loaderDeps").mockReturnValue("")] : []),
  ]);
  try {
    await startApplicationRouter(router, history, "/ui", context);
    expect(router.getState().resolvedLocation).toEqual(location(expectedUrl));
    expect(replace).toHaveBeenCalledExactlyOnceWith(location(expectedUrl));
    expect(history.push).not.toHaveBeenCalled();
    await router.navigate("portals", context, { history: "push" });
    const requested = location(requestedUrl);
    current = requested;
    pop(requested);
    await vi.waitFor(() =>
      expect(router.getState().resolvedLocation).toEqual(location(expectedUrl)),
    );
    expect(current).toEqual(location(expectedUrl));
    expect(history.push).toHaveBeenCalledOnce();
  } finally {
    router.stop();
    for (const mock of mocks) {
      mock.mockRestore();
    }
  }
});

it("leaves embedded Settings intact and intercepts the requested URL before canonicalization", async () => {
  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", { platform: "ios", formFactor: "phone" });
  const router = createApplicationRouter();
  const settings = router.getRoute("settings")!;
  const component = vi.spyOn(settings, "component").mockResolvedValue({ renderSolid: () => null });
  const interceptNavigation = vi.fn(() => false);
  // SAFETY: Native Settings has no data loader and interception owns the second navigation.
  const context = {
    basePath: "",
    nativeConversation: { interceptNavigation },
  } as unknown as ApplicationContext;
  try {
    await router.navigate("settings", context);
    expect(router.getState().resolvedLocation).toEqual({
      pathname: "/settings",
      search: "",
      hash: "",
    });
    interceptNavigation.mockReturnValue(true);
    const requested = { pathname: "/automation", search: "?section=plugins", hash: "#anchor" };
    await router.navigate("automation", context, { history: "push" }, requested);
    expect(interceptNavigation).toHaveBeenLastCalledWith(requested);
    expect(router.getState().resolvedLocation?.pathname).toBe("/settings");
  } finally {
    router.stop();
    component.mockRestore();
    vi.unstubAllGlobals();
  }
});
