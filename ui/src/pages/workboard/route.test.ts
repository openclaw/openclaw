import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationRouter, startApplicationRouter, type RouteId } from "../../app-routes.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { resolveWorkboardRouteLocation } from "./route-location.ts";

function at(pathname: string, search = "", hash = ""): RouteLocation {
  return { pathname, search, hash };
}

function routeFixture(initialLocation = at("/ui/settings/about")) {
  const basePath = "/ui";
  let location = initialLocation;
  let historyListener: ((location: RouteLocation) => void) | undefined;
  const history: RouterHistory = {
    location: () => location,
    push: (next) => {
      location = next;
    },
    replace: (next) => {
      location = next;
    },
    listen: (listener) => {
      historyListener = listener;
      return () => {
        historyListener = undefined;
      };
    },
  };
  const router = createApplicationRouter();
  onTestFinished(() => router.stop());
  const loading = createDeferred();
  const component = createDeferred<{ renderSolid: () => null }>();
  router.getRoute("about")!.component = async () => ({ renderSolid: () => null });
  router.getRoute("workboard")!.component = () => {
    loading.resolve();
    return component.promise;
  };
  const metadata = createDeferred();
  const redirects: Promise<void>[] = [];
  const context = {
    basePath,
    gateway: createApplicationGateway().gateway,
    runtimeConfig: {
      ensureLoaded: () => metadata.promise,
    },
    agents: { ensureList: async () => null },
    sessions: { state: { result: {}, loading: false } },
    replace: (routeId: RouteId, options?: ApplicationNavigationOptions) => {
      redirects.push(
        router.navigate(
          routeId,
          context,
          { history: "replace" },
          {
            pathname: router.pathForRoute(routeId, basePath),
            search: "",
            hash: "",
            ...options,
          },
        ),
      );
    },
  } as unknown as ApplicationContext;
  const started = startApplicationRouter(router, history, basePath, context);
  return {
    router,
    history,
    context,
    loading,
    redirects,
    started,
    navigate(next: RouteLocation) {
      return router.navigate("workboard", context, { history: "push" }, next);
    },
    async expectLocation(next: RouteLocation) {
      await Promise.all(redirects);
      expect(history.location()).toEqual(next);
      expect(router.getState().location).toEqual(next);
    },
    resolve() {
      metadata.resolve();
      component.resolve({ renderSolid: () => null });
    },
    pop(next: RouteLocation) {
      location = next;
      historyListener?.(next);
    },
  };
}

const legacyBoardLocation = at("/ui/workboard", "?board=ops&agent=writer", "#original");
const canonicalBoardLocation = at("/ui/workboard/ops", "?agent=writer", "#original");

describe("Workboard route navigation ownership", () => {
  it("keeps a newer query and hash on the same board when old route loading finishes", async () => {
    const location = at("/ui/workboard/ops", "?agent=reviewer", "#latest");
    const fixture = routeFixture();
    await fixture.started;
    const oldNavigation = fixture.navigate(legacyBoardLocation);
    await fixture.loading.promise;
    const newNavigation = fixture.navigate(location);
    fixture.resolve();
    await Promise.all([oldNavigation, newNavigation]);
    await fixture.expectLocation(location);
    expect(fixture.router.getState().matches[0]?.routeId).toBe("workboard");
  });

  it("preloads without navigation and canonicalizes the later visit to the cached board", async () => {
    const fixture = routeFixture();
    await fixture.started;
    const activeLocation = fixture.history.location();
    const preload = fixture.router.preloadLocation(legacyBoardLocation, fixture.context);
    await fixture.loading.promise;
    fixture.resolve();
    await preload;
    await fixture.expectLocation(activeLocation);
    expect(fixture.router.getState().matches[0]?.routeId).toBe("about");
    await fixture.navigate(legacyBoardLocation);
    await fixture.expectLocation(canonicalBoardLocation);
    expect(fixture.router.getState().matches[0]?.data).toMatchObject({ boardFilter: "ops" });
  });

  it.each(["startup", "history"] as const)(
    "canonicalizes a %s alias before asynchronous route loading",
    async (entry) => {
      const fixture = routeFixture(entry === "startup" ? legacyBoardLocation : undefined);
      if (entry === "history") {
        await fixture.started;
        fixture.pop(legacyBoardLocation);
      }
      await fixture.loading.promise;
      expect.soft(fixture.history.location()).toEqual(canonicalBoardLocation);
      fixture.resolve();
      await fixture.started;
      await Promise.all(fixture.redirects);
      await vi.waitFor(() => {
        expect(fixture.router.getState()).toMatchObject({
          status: "success",
          location: canonicalBoardLocation,
        });
      });
      expect(fixture.router.getState().matches[0]?.data).toMatchObject({ boardFilter: "ops" });
    },
  );
});

it("normalizes an invalid legacy board to the all-boards route", () => {
  expect(
    resolveWorkboardRouteLocation(at("/ui/workboard", "?board=not%20valid&agent=main"), "/ui"),
  ).toEqual({
    boardFilter: "__all__",
    search: "?agent=main",
    canonicalLocation: at("/ui/workboard", "?agent=main"),
  });
});
