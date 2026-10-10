import { render as mountSolid } from "@solidjs/web";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  createContext,
  createGateway,
  createSessions,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { SidebarMenusController } from "./sidebar-menus-controller.tsx";

describe("SidebarMenusController session routes", () => {
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
      addController: vi.fn(),
      basePath: "",
      enabledRouteIds: ["chat", "dashboard"],
      getRouteSessionKey: () => sessionKey,
      onNavigate,
      requestUpdate: vi.fn(),
      sessionDataContext: context,
      terminalAvailable: false,
    } as unknown as ConstructorParameters<typeof SidebarMenusController>[0];
    const controller = new SidebarMenusController(host);
    const container = document.createElement("div");

    document.body.append(container);
    let dispose: (() => void) | undefined;
    try {
      dispose = mountSolid(() => controller.renderRoute("chat"), container);
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
      dispose = mountSolid(() => controller.renderRoute("dashboard"), container);
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
      controller.hostDisconnected();
    }
  });
});
