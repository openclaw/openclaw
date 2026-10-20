import { describe, expect, it, vi } from "vitest";
import {
  APP_ROUTE_IDS,
  pathForRoute,
  routeIdFromPath,
  sameRouteLocation,
} from "./app-route-paths.ts";
import { createApplicationRouter } from "./app-routes.ts";

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
