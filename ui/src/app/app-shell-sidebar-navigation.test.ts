/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import "../components/app-sidebar.tsx";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { mountShell } from "./app-shell-view.test-support.ts";

setupSidebarTest();

it.each(["loaded", "unresolved"] as const)(
  "restores the Sessions sidebar after a rapid router round trip through %s Activity",
  async (activityState) => {
    const { owner, runtime, query, settle } = await mountShell();
    owner.connect();
    await runtime.router.navigate("sessions", runtime.context);
    await settle();
    // SAFETY: mountShell has loaded the registered sidebar and settled its bridge.
    const sidebar = owner.navigationSidebar as AppSidebarElement;
    expect(sidebar.activeRouteId).toBe("sessions");
    expect(sidebar.navigationView).toBe("sessions");

    const activityModule = Promise.withResolvers<{ renderSolid: () => null }>();
    if (activityState === "unresolved") {
      vi.spyOn(runtime.router.getRoute("activity")!, "component").mockReturnValue(
        activityModule.promise,
      );
    }
    onTestFinished(() => activityModule.resolve({ renderSolid: () => null }));
    const returned = Promise.withResolvers<void>();
    const routes: Array<{
      route: string | undefined;
      bridge: string | undefined;
      pending: string | undefined;
    }> = [];
    let returning = false;
    const stop = runtime.router.subscribe((state) => {
      const route = selectShellRouteState(state).routeId;
      const pending = state.pendingMatches[0]?.routeId;
      routes.push({ route, bridge: sidebar.activeRouteId, pending });
      if ((activityState === "unresolved" ? pending : route) === "activity" && !returning) {
        returning = true;
        void runtime.router
          .navigate("sessions", runtime.context)
          .then(returned.resolve, returned.reject);
      }
    });
    onTestFinished(() => {
      stop();
    });
    query<HTMLButtonElement>('[data-navigation-view="online"]')!.click();
    await returned.promise;
    await settle();
    expect(
      routes.some(
        ({ route, pending }) => (activityState === "unresolved" ? pending : route) === "activity",
      ),
    ).toBe(true);
    expect(sidebar.activeRouteId).toBe("sessions");
    expect(sidebar.navigationView, JSON.stringify(routes)).toBe("sessions");
  },
);

it.each(["loaded", "preloaded"] as const)(
  "keeps a %s page's sidebar after navigating from a rail preview",
  async (cache) => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => Object.assign(new EventTarget(), { matches: false })),
    );
    const { owner, runtime, query, settle } = await mountShell();
    owner.connect();
    if (cache === "loaded") {
      await runtime.router.navigate("activity", runtime.context);
    }
    await runtime.router.navigate("sessions", runtime.context);
    if (cache === "preloaded") {
      await runtime.router.preloadRoute("activity", runtime.context);
    }
    await runtime.router.navigate("dashboards", runtime.context);
    runtime.context.navigation.update({ navCollapsed: true });
    await settle();
    const sidebar = owner.navigationSidebar as AppSidebarElement;
    expect(sidebar.navigationView).toBe("sessions");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const event = new Event("pointerover", { bubbles: true });
    Object.assign(event, { pointerType: "mouse" });
    query('[data-navigation-view="online"]')!.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    await settle();
    expect(sidebar.hasAttribute("data-peek")).toBe(true);
    query<HTMLAnchorElement>(".sidebar-online__overview a")!.click();
    await vi.dynamicImportSettled();
    await settle();
    expect(sidebar.activeRouteId).toBe("activity");
    expect(sidebar.hasAttribute("data-peek")).toBe(false);
    expect(sidebar.navigationView).toBe("online");
  },
);

it("keeps the displayed page's sidebar until a cold destination loads", async () => {
  const { owner, runtime, settle } = await mountShell();
  owner.connect();
  await runtime.router.navigate("systems", runtime.context);
  await settle();
  const sidebar = owner.navigationSidebar as AppSidebarElement;
  expect(sidebar.navigationView).toBe("sessions");
  const module = Promise.withResolvers<{ renderSolid: () => null }>();
  vi.spyOn(runtime.router.getRoute("cron")!, "component").mockReturnValue(module.promise);
  onTestFinished(() => module.resolve({ renderSolid: () => null }));
  const navigation = runtime.router.navigate("cron", runtime.context);
  await settle();
  expect(runtime.router.getState().pendingMatches[0]?.routeId).toBe("cron");
  expect(sidebar.activeRouteId).toBe("systems");
  expect(sidebar.navigationView).toBe("sessions");
  module.resolve({ renderSolid: () => null });
  await navigation;
  await settle();
  expect(sidebar.activeRouteId).toBe("cron");
  expect(sidebar.navigationView).toBe("automations");
});

it.each(["pages", "online"] as const)(
  "preserves the manually selected %s view through revalidation and metadata updates",
  async (view) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        Object.assign(new EventTarget(), {
          matches: view === "online" && !query.includes("600px") && !query.includes("640px"),
        }),
      ),
    );
    const { owner, runtime, query, settle } = await mountShell();
    owner.connect();
    await runtime.router.navigate("sessions", runtime.context);
    await settle();
    const sidebar = owner.navigationSidebar as AppSidebarElement;
    query<HTMLButtonElement>(
      view === "pages" ? "[data-rail-more]" : '[data-navigation-view="online"]',
    )!.click();
    await vi.dynamicImportSettled();
    await settle();
    expect(sidebar.navigationView).toBe(view === "pages" ? "sessions" : "online");
    if (view === "pages") {
      expect(query(".sidebar-pages")).not.toBeNull();
    }
    await runtime.router.revalidate(runtime.context, "sessions");
    runtime.context.gateway.setSessionKey("agent:main:metadata-update");
    runtime.context.plugins.selectReplacement("workspace", null);
    await settle();
    expect(runtime.router.getState().matches[0]?.routeId).toBe("sessions");
    expect(sidebar.navigationView).toBe(view === "pages" ? "sessions" : "online");
    if (view === "pages") {
      expect(query(".sidebar-pages")).not.toBeNull();
    }
  },
);
