/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.tsx";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

describe("SidebarCatalogMenuController", () => {
  it.each([
    ["https://team.example.com/chat/main/shared", true],
    ["javascript:alert(1)", false],
    ["//evil.example/session", false],
    ["https://user:secret@team.example.com/chat", false],
    ["https://team.example.com/chat?token=secret", false],
    ["https://team.example.com/chat#token", false],
  ])("opens only safe source links without local navigation: %s", async (originalUrl, allowed) => {
    const navigate = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const controller = new SidebarCatalogMenuController(
      {
        basePath: "",
        getRouteSessionKey: () => "",
        requestUpdate: vi.fn(),
        terminalAvailable: false,
        onNavigate: navigate,
        sessionDataContext: undefined,
        sessionData: {
          beginSessionMutation: vi.fn(),
          isSessionMutationScopeCurrent: vi.fn(),
          archiveSessionCatalog: vi.fn(),
          importSessionCatalog: vi.fn(),
          sessionScopeGeneration: 0,
        },
      },
      vi.fn(),
    );
    const container = document.createElement("div");
    document.body.append(container);
    let unmount: (() => void) | undefined;
    try {
      controller.open(
        {
          key: { catalogId: "fixture", hostId: "node:team", threadId: "agent:main:shared" },
          agentId: "main",
          routeId: "chat",
          navigation: {},
          canOpenTerminal: false,
          canDelete: false,
          name: "Shared",
          meta: "now",
          originalUrl,
        },
        10,
        20,
      );
      unmount = mountSolid(() => controller.render(), { container }).unmount;
      await waitForSolid(() => expect(container.querySelector('[role="menu"]')).not.toBeNull());
      const menu = container.querySelector("openclaw-catalog-session-menu") as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await menu.updateComplete;
      const original = menu.querySelector<HTMLElement>('[data-value="original"]');
      expect(Boolean(original)).toBe(allowed);
      original?.click();
      if (allowed) {
        await waitForSolid(() =>
          expect(open).toHaveBeenCalledExactlyOnceWith(
            originalUrl,
            "_blank",
            "noopener,noreferrer",
          ),
        );
      } else {
        expect(open).not.toHaveBeenCalled();
      }
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      unmount?.();
      container.remove();
      open.mockRestore();
    }
  });

  it("dismisses the matching hovercard before opening the catalog menu", () => {
    const trigger = document.createElement("button");
    const order: string[] = [];
    trigger.addEventListener(SESSION_MENU_OPEN_EVENT, () => order.push("dismiss"));
    const controller = new SidebarCatalogMenuController(
      {
        basePath: "",
        getRouteSessionKey: () => "",
        requestUpdate: vi.fn(),
        terminalAvailable: true,
        sessionDataContext: undefined,
        sessionData: {
          beginSessionMutation: vi.fn(),
          isSessionMutationScopeCurrent: vi.fn(),
          archiveSessionCatalog: vi.fn(),
          importSessionCatalog: vi.fn(),
          sessionScopeGeneration: 0,
        },
      },
      () => order.push("open"),
    );

    controller.open(
      {
        key: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
        agentId: "main",
        routeId: "chat",
        navigation: {},
        canOpenTerminal: true,
        canDelete: false,
        name: "Shared session",
        meta: "now",
      },
      10,
      20,
      trigger,
    );

    expect(order).toEqual(["dismiss", "open"]);
  });
});
