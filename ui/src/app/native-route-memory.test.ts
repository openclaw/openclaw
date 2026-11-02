import { beforeEach, describe, expect, it } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";

let storage: Storage;

beforeEach(() => {
  storage = createStorageMock();
});

describe("native route memory", () => {
  it.each([
    { routeId: "usage", pathname: "/usage", search: "?agent=main" },
    { routeId: "chat", pathname: "/chat/research/chat/saved", search: "" },
  ] as const)("persists and restores a non-Home $routeId route", (route) => {
    persistRoute(route.routeId, route.pathname, route.search, storage, true);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toEqual(route);
  });

  it.each([
    "/control/chat",
    "/control/chat/main",
    "/control/chat/research/~key/workspace",
    "/control/dashboard/research",
  ])("does not implicitly restore Home at %s", (pathname) => {
    persistRoute(
      pathname.includes("/dashboard/") ? "dashboard" : "chat",
      pathname,
      "",
      storage,
      true,
    );
    expect(
      considerRouteRestore("chat", "/control/chat", "", storage, true, "workspace"),
    ).toBeNull();
  });

  it.each([
    ["chat", "/chat/research/chat/explicit", ""],
    ["chat", "/chat", "?draft=hello"],
    ["new-session", "/new", "?draft=hello"],
    ["new-session", "/new", ""],
  ] as const)("preserves explicit %s %s%s", (routeId, pathname, search) => {
    persistRoute("usage", "/usage", "", storage, true);
    expect(considerRouteRestore(routeId, pathname, search, storage, true)).toBeNull();
  });

  it.each([
    "{",
    ...["retired", "__proto__"].map((routeId) =>
      JSON.stringify({ routeId, pathname: `/${routeId}`, search: "" }),
    ),
  ])("drops corrupt or invalid entry %s", (raw) => {
    storage.setItem("openclaw.native.lastRoute", raw);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();
  });

  it("does nothing outside the native host", () => {
    storage.setItem(
      "openclaw.native.lastRoute",
      JSON.stringify({ routeId: "usage", pathname: "/usage", search: "" }),
    );
    persistRoute("chat", "/chat/main", "", storage, false);
    expect(considerRouteRestore("chat", "/chat", "", storage, false)).toBeNull();
    expect(JSON.parse(storage.getItem("openclaw.native.lastRoute") ?? "{}")).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "",
    });
  });

  it("skips restoring the route it is already on", () => {
    persistRoute("chat", "/chat", "", storage, true);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toBeNull();
  });
});
