/* @vitest-environment jsdom */

import { render as mountSolid } from "@solidjs/web";
import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  catalogPage,
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import { menuItemLabels, openSubmenu } from "../test-helpers/session-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import { createSidebarMenus } from "./sidebar-menus.tsx";

describe("sidebar menus session routes", () => {
  it("keeps the current catalog session when switching either face", () => {
    const sessionKey = buildCatalogSessionKey({
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const context = createContext(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", [sessionKey]),
      TWO_AGENTS,
    );
    Object.assign(context, { basePath: "" });
    const onNavigate = vi.fn();
    const host = {
      activeRouteId: "chat",
      basePath: "",
      enabledRouteIds: ["chat", "dashboard"],
      getRouteSessionKey: () => sessionKey,
      onNavigate,
      sessionDataContext: context,
      terminalAvailable: false,
    } as unknown as SidebarMenusOwner;
    const container = document.createElement("div");
    const { menus, disposeMenus } = createRoot((disposeRoot) => ({
      menus: createSidebarMenus({
        host,
        element: container,
        commit: () => Promise.resolve(true),
      }),
      disposeMenus: disposeRoot,
    }));

    document.body.append(container);
    let dispose: (() => void) | undefined;
    try {
      dispose = mountSolid(() => menus.renderRoute("chat", host), container);
      flush();
      const chat = container.querySelector<HTMLAnchorElement>("a");
      expect(chat?.getAttribute("href")).toBe(
        "/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      );
      chat?.click();
      expect(onNavigate).toHaveBeenLastCalledWith("chat", {
        pathname: "/chat/main",
        search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      });

      dispose();
      dispose = mountSolid(() => menus.renderRoute("dashboard", host), container);
      flush();
      const dashboard = container.querySelector<HTMLAnchorElement>("a");
      expect(dashboard?.getAttribute("href")).toBe(
        "/dashboard/main?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      );
      dashboard?.click();
      expect(onNavigate).toHaveBeenLastCalledWith("dashboard", {
        pathname: "/dashboard/main",
        search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      });
    } finally {
      dispose?.();
      container.remove();
      disposeMenus();
    }
  });
});

describe("mounted sidebar menus", () => {
  setupSidebarTest();
  afterEach(clearNativeGatewayTestState);

  it("closes the filter popup when the gateway viewer changes", async () => {
    const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
    gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
    const { sidebar } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
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
    const { sidebar, provider, context } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    const trigger = () => sidebar.querySelector<HTMLButtonElement>("[data-catalog-session-menu]")!;
    const popup = () => sidebar.querySelector("openclaw-catalog-session-menu");
    await waitForSolid(() => expect(trigger()).not.toBeNull());
    const originalTrigger = trigger();
    originalTrigger.click();
    await waitForSolid(() => {
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(popup()!.querySelector('[data-value="viewer"]')).not.toBeNull();
    });

    provider.setContext({ ...context });
    await sidebar.updateComplete;
    await waitForSolid(() => {
      expect(trigger()).not.toBe(originalTrigger);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(popup()!.querySelector('[data-value="viewer"]')).not.toBeNull();
    });

    popup()!
      .querySelector('[data-value="viewer"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitForSolid(() => {
      expect(popup()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });
    trigger().click();
    await waitForSolid(() => {
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(popup()!.querySelector('[data-value="viewer"]')).not.toBeNull();
    });
  });

  it.each([
    "provider replacement",
    "client replacement",
    "native disconnect and reconnect",
  ] as const)("keeps session-menu work scoped across %s", async (transition) => {
    setNativeGatewayTestState("local");
    const retired = createDeferred<{ worktrees: WorktreeRecord[] }>();
    const current = createDeferred<{ worktrees: WorktreeRecord[] }>();
    const worktrees = vi.fn().mockReturnValueOnce(retired.promise).mockReturnValue(current.promise);
    const request = createGatewayRequestMock((method) =>
      method === "worktrees.list" ? worktrees() : Promise.resolve({}),
    );
    const sessions = createSessionsHarness("main", ["agent:main:checkout"]);
    const result = sessions.sessions.state.result!;
    sessions.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          Object.assign({}, row, {
            worktree: { id: "wt-1", branch: "main", repoRoot: "/synthetic/repo" },
          }),
        ),
      },
    });
    const response: { worktrees: WorktreeRecord[] } = {
      worktrees: [
        {
          id: "wt-1",
          name: "checkout",
          repoFingerprint: "0123456789abcdef",
          repoRoot: "/synthetic/repo",
          path: "/synthetic/worktrees/checkout",
          branch: "main",
          baseRef: "main",
          ownerKind: "session",
          createdAt: 1,
          lastActiveAt: 1,
        },
      ],
    };
    try {
      const gateway = createGatewayHarness(createTestGatewayClient(request));
      const { sidebar, provider, context } = await mountSidebar(gateway.gateway, sessions.sessions);
      sidebar.connected = true;
      await sidebar.updateComplete;
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
        expect(editor).not.toBeNull();
        expect(editor?.disabled).toBe(false);
      });
    } finally {
      retired.resolve({ worktrees: [] });
      current.resolve({ worktrees: [] });
    }
  });
});
