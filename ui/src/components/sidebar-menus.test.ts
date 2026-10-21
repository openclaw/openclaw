/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  catalogPage,
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import { menuItemLabels, openSubmenu } from "../test-helpers/session-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import { createSidebarMenus } from "./sidebar-menus.tsx";
setupSidebarTest();
afterEach(clearNativeGatewayTestState);

it("keeps the current catalog session when switching either face", async () => {
  const sessionKey = buildCatalogSessionKey({
    catalogId: "claude",
    hostId: "gateway:local",
    threadId: "thread-1",
  });
  const { sidebar, context } = await mountSidebar(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", [sessionKey]),
    "panel",
    TWO_AGENTS,
  );
  Object.assign(context, { basePath: "" });
  const onNavigate = vi.fn();
  Object.assign(sidebar, {
    enabledRouteIds: ["chat", "dashboard"],
    sessionKey,
    onNavigate,
  });
  await sidebar.updateComplete;
  const host = getAppSidebarOwner(sidebar.hostElement)!;
  const search = "?catalog=claude&host=gateway%3Alocal&thread=thread-1";
  for (const route of ["chat", "dashboard"] as const) {
    const view = mountSolid(() => host.sidebarMenus.renderRoute(route, host));
    flush();
    const link = view.container.querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe(`/${route}/main${search}`);
    link?.click();
    expect(onNavigate).toHaveBeenLastCalledWith(route, { pathname: `/${route}/main`, search });
    view.unmount();
  }
});
async function mountConnected(
  gateway: Parameters<typeof mountSidebar>[0],
  sessions = createSessions("main", ["agent:main:main"]),
) {
  const mounted = await mountSidebar(gateway, sessions);
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  return mounted;
}

it("closes the filter popup when the gateway viewer changes", async () => {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  const { sidebar } = await mountConnected(gateway.gateway);
  const trigger = () => sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!;
  const popup = () => sidebar.querySelector(".sidebar-session-sort-menu");
  trigger().click();
  await waitForSolid(() => expect(popup()).not.toBeNull());

  gateway.publish({ selfUser: { id: "profile-bob", name: "Bob" } });
  await waitForSolid(() => {
    expect(trigger()).not.toBeNull();
    expect(popup()).toBeNull();
  });
  trigger().click();
  await waitForSolid(() => expect(popup()).not.toBeNull());
});

it("keeps the catalog popup and row state live after provider replacement", async () => {
  vi.useFakeTimers();
  const request = createGatewayRequestMock().mockResolvedValue(
    catalogPage([{ threadId: "thread-1", name: "Catalog session" }]),
  );
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({ hello: gatewayHelloForMethods(["sessions.catalog.list"]) });
  const { sidebar, provider, context } = await mountConnected(gateway.gateway);
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
  const trigger = () => sidebar.querySelector<HTMLButtonElement>("[data-catalog-session-menu]")!;
  const popup = () => sidebar.querySelector("openclaw-catalog-session-menu");
  const expectOpen = () => {
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(popup()!.querySelector('[data-value="viewer"]')).not.toBeNull();
  };
  await waitForSolid(() => expect(trigger()).not.toBeNull());
  const originalTrigger = trigger();
  originalTrigger.click();
  await waitForSolid(expectOpen);

  provider.setContext({ ...context });
  await sidebar.updateComplete;
  await waitForSolid(() => {
    expect(trigger()).not.toBe(originalTrigger);
    expectOpen();
  });

  popup()!
    .querySelector('[data-value="viewer"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitForSolid(() => {
    expect(popup()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
  trigger().click();
  await waitForSolid(expectOpen);
});

it.each(["provider replacement", "client replacement", "native disconnect and reconnect"] as const)(
  "keeps session-menu work scoped across %s",
  async (transition) => {
    setNativeGatewayTestState("local");
    type WorktreePage = { worktrees: Pick<WorktreeRecord, "id" | "path">[] };
    const retired = createDeferred<WorktreePage>();
    const current = createDeferred<WorktreePage>();
    const worktrees = vi.fn().mockReturnValueOnce(retired.promise).mockReturnValue(current.promise);
    const request = createGatewayRequestMock((method) =>
      method === "worktrees.list" ? worktrees() : Promise.resolve({}),
    );
    const sessions = createSessions("main", ["agent:main:checkout"]);
    Object.assign(sessions.state.result!.sessions[0]!, {
      worktree: { id: "wt-1", branch: "main", repoRoot: "/synthetic/repo" },
    });
    const response: WorktreePage = {
      worktrees: [{ id: "wt-1", path: "/synthetic/worktrees/checkout" }],
    };
    try {
      const gateway = createGatewayHarness(createTestGatewayClient(request));
      const { sidebar, provider, context } = await mountConnected(gateway.gateway, sessions);
      const trigger = () =>
        sidebar.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!;
      trigger().click();
      await waitForSolid(() => expect(worktrees).toHaveBeenCalledTimes(1));

      if (transition === "provider replacement") {
        provider.setContext({ ...context });
        await sidebar.updateComplete;
        expect(worktrees).toHaveBeenCalledTimes(1);
      } else if (transition === "client replacement") {
        gateway.publish({ client: createTestGatewayClient(request), phase: "reconnecting" });
        await sidebar.updateComplete;
      } else {
        sidebar.hostElement.remove();
        await sidebar.updateComplete;
        flush();
        provider.append(sidebar.hostElement);
        await sidebar.updateComplete;
        await waitForSolid(() => expect(trigger()).not.toBeNull());
        trigger().click();
        await waitForSolid(() => expect(worktrees).toHaveBeenCalledTimes(2));
      }
      await waitForSolid(() =>
        expect(sidebar.querySelector("openclaw-session-menu")).not.toBeNull(),
      );
      const menu = sidebar.querySelector("openclaw-session-menu")!;
      const advanced = await openSubmenu(menu, "Advanced");
      expect(menuItemLabels(advanced)).toContain("Open in");
      const openIn = await openSubmenu(advanced, "Open in");
      expect(menuItemLabels(openIn)).toContain("New tab");
      expect(openIn.querySelector('[data-value="open-in:vscode"]')).toBeNull();

      retired.resolve(response);
      await vi.dynamicImportSettled();
      await sidebar.updateComplete;
      if (transition !== "provider replacement") {
        expect(openIn.querySelector('[data-value="open-in:vscode"]')).toBeNull();
        if (transition === "client replacement") {
          expect(worktrees).toHaveBeenCalledTimes(1);
          gateway.publish({ phase: "connected" });
          await waitForSolid(() => expect(worktrees).toHaveBeenCalledTimes(2));
        }
        current.resolve(response);
      }
      await waitForSolid(() => {
        const editor = openIn.querySelector<HTMLButtonElement>('[data-value="open-in:vscode"]');
        expect(editor).toMatchObject({ disabled: false });
      });
    } finally {
      retired.resolve({ worktrees: [] });
      current.resolve({ worktrees: [] });
    }
  },
);

it.each(["close", "disconnect"] as const)(
  "does not load session work when the menu closes before its renderer loads (%s)",
  async (action) => {
    setNativeGatewayTestState("local");
    const request = createGatewayRequestMock(async () => ({ worktrees: [] }));
    const { sidebar } = await mountConnected(createGateway(createTestGatewayClient(request)));
    const host = getAppSidebarOwner(sidebar.hostElement)!;
    const menus = createSidebarMenus({
      host,
      element: sidebar.hostElement,
      commit: async () => true,
    });
    const session = {
      ...host.findSidebarMenuSessionByKey("agent:main:main")!,
      worktreeId: "wt-1",
    };
    try {
      menus.connect();
      menus.openSessionMenu(session, 0, 0);
      if (action === "close") {
        menus.closeSessionMenu();
      } else {
        menus.disconnect();
      }
      await menus.preloadMenuRenderer();
      expect(request).not.toHaveBeenCalledWith("worktrees.list", expect.anything());
      menus.closeSessionMenu();
      menus.connect();
      menus.openSessionMenu(session, 0, 0);
      await vi.dynamicImportSettled();
      expect(request).toHaveBeenCalledWith("worktrees.list", {});
    } finally {
      menus.dispose();
    }
  },
);
