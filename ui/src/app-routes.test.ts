import { describe, expect, it } from "vitest";
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
