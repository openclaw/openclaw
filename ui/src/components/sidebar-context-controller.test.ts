/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createSidebarTestRouter } from "../test-helpers/app-sidebar-router.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";

setupSidebarTest();

const mountEmptySidebar = () =>
  mountSidebar(createGateway({} as GatewayBrowserClient), createSessions("main", []));

it("restores destination offsets and updates fades after content commits", async () => {
  const { sidebar } = await mountEmptySidebar();
  const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  let contentHeight = 500;
  Object.defineProperty(scroller, "clientHeight", { value: 100 });
  Object.defineProperty(scroller, "scrollHeight", { get: () => contentHeight });
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
  const navigate = async (route: "systems" | "cron", offset: number) => {
    await router.navigate(route, {});
    await sidebar.updateComplete;
    expect(scroller.scrollTop).toBe(offset);
  };
  sidebar.router = router;
  await navigate("systems", 0);
  // Navigation must also capture an offset whose native scroll event has not arrived yet.
  scroller.scrollTop = 35;
  await navigate("cron", 140);
  await navigate("systems", 35);

  contentHeight = 80;
  await router.navigate("cron", {});
  await expectFade("none");
});

it("updates contextual navigation from its router and retires the subscription on detach", async () => {
  const loaded = createDeferred<unknown>();
  const router = createSidebarTestRouter((_data, pending) =>
    pending ? "loading machines" : "machine inventory",
  );
  router.getRoute("systems")!.loader = () => loaded.promise;
  const { sidebar } = await mountEmptySidebar();
  sidebar.router = router;
  await sidebar.updateComplete;
  const navigation = router.navigate("systems", {});
  await vi.waitFor(() => expect(sidebar.contextualSidebar?.loaderPending).toBe(true));
  loaded.resolve({ machine: "worker-one" });
  await navigation;
  await sidebar.updateComplete;
  expect(sidebar.contextualSidebar?.loaderPending).toBe(false);
  expect(sidebar.querySelector(".sidebar-shell__body")?.textContent).toContain("machine inventory");
  const replacement = createSidebarTestRouter(() => "replacement");
  sidebar.router = replacement;
  await replacement.navigate("systems", {});
  await sidebar.updateComplete;
  await router.navigate("cron", {});
  await sidebar.updateComplete;
  expect(sidebar.querySelector(".sidebar-shell__body")?.textContent).toContain("replacement");
  sidebar.remove();
  await waitForSolid(() => expect(getAppSidebarOwner(sidebar.hostElement)).toBeUndefined());
  await replacement.navigate("cron", {});
  await replacement.navigate("systems", {});
  expect(sidebar.contextualSidebar).toBeUndefined();
});
