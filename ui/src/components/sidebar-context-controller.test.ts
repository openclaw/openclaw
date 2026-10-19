/* @vitest-environment jsdom */
import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import { createSidebarTestRouter } from "../test-helpers/app-sidebar-router.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";

setupSidebarTest();

it("restores destination offsets and updates fades after content commits", async () => {
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", []),
  );
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  let contentHeight = 500;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => contentHeight },
  });
  const expectFade = (state: string) =>
    waitForSolid(() =>
      expect(scroller.classList.contains(`sidebar-shell__body--scroll-${state}`)).toBe(true),
    );
  scroller.scrollTop = 140;
  scroller.dispatchEvent(new Event("scroll"));
  await expectFade("middle");

  sidebar.navigationView = "pages";
  await sidebar.updateComplete;
  expect(scroller.scrollTop).toBe(0);
  await expectFade("top");
  scroller.scrollTop = 400;
  scroller.dispatchEvent(new Event("scroll"));
  await expectFade("bottom");
  sidebar.navigationView = "sessions";
  await sidebar.updateComplete;
  expect(scroller.scrollTop).toBe(140);

  const router = createSidebarTestRouter(() => "machine inventory");
  sidebar.router = router;
  await router.navigate("systems", {});
  await sidebar.updateComplete;
  expect(scroller.scrollTop).toBe(0);
  // Navigation must also capture an offset whose native scroll event has not arrived yet.
  scroller.scrollTop = 35;
  await router.navigate("cron", {});
  await sidebar.updateComplete;
  expect(scroller.scrollTop).toBe(140);
  await router.navigate("systems", {});
  await sidebar.updateComplete;
  expect(scroller.scrollTop).toBe(35);

  contentHeight = 80;
  await router.navigate("cron", {});
  await expectFade("none");
});

type RouteModule = NonNullable<
  ReturnType<ApplicationRouter["getState"]>["matches"][number]["module"]
>;

it("updates contextual navigation from its router and retires the subscription on detach", async () => {
  const loaded = createDeferred<unknown>();
  const router = createRouter<RouteId, unknown, RouteModule>({
    routes: [
      definePage({
        id: "systems",
        path: "/systems",
        component: () => ({
          renderSolid: () => "workspace",
          renderSidebar: (_data: unknown, pending: boolean) =>
            pending ? "loading machines" : "machine inventory",
        }),
        loader: () => loaded.promise,
      }),
      definePage({ id: "cron", path: "/cron", component: () => ({ renderSolid: () => "cron" }) }),
    ],
  });
  onTestFinished(() => router.stop());
  const { provider, sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", []),
  );
  const element = provider.querySelector<HTMLElement>("openclaw-app-sidebar")!;
  const owner = getAppSidebarOwner(element);
  expect(owner).toBeDefined();
  sidebar.router = router;
  await sidebar.updateComplete;
  expect(getAppSidebarOwner(element)).toBe(owner);
  const navigation = router.navigate("systems", {});
  await vi.waitFor(() => expect(sidebar.contextualSidebar?.loaderPending).toBe(true));
  const pending = sidebar.contextualSidebar;
  const data = { machine: "worker-one" };
  loaded.resolve(data);
  await navigation;
  await sidebar.updateComplete;
  expect(sidebar.contextualSidebar?.loaderPending).toBe(false);
  expect(sidebar.contextualSidebar?.data).toBe(data);
  expect(pending?.loaderPending).toBe(true);
  expect(sidebar.querySelector(".sidebar-shell__body")?.textContent).toContain("machine inventory");
  const replacement = createSidebarTestRouter(() => "replacement machines");
  sidebar.router = replacement;
  await replacement.navigate("systems", {});
  await sidebar.updateComplete;
  await router.navigate("cron", {});
  await sidebar.updateComplete;
  expect(sidebar.querySelector(".sidebar-shell__body")?.textContent).toContain(
    "replacement machines",
  );
  sidebar.remove();
  await waitForSolid(() => expect(getAppSidebarOwner(element)).toBeUndefined());
  expect(sidebar.contextualSidebar).toBeUndefined();
  await replacement.navigate("cron", {});
  await replacement.navigate("systems", {});
  expect(sidebar.contextualSidebar).toBeUndefined();
});
