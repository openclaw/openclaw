/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { bindChatPageSession } from "../pages/chat/chat-state-route.ts";
import {
  other,
  ownedSession,
  viewer,
  withOwnerSidebar,
} from "../test-helpers/agent-sidebar.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { storeSidebarSessionOwnerFilter } from "./app-sidebar-session-types.ts";

it("intersects selected owners with each agent and opens an unloaded agent's Home", async () => {
  const rows: GatewaySessionRow[] = [
    ownedSession("agent:main:mine", "viewer"),
    ownedSession("agent:research:shared", "other", {
      updatedAt: 3000,
      unread: true,
    }),
    ownedSession("agent:research:dashboard:00000002-0000-4000-8000-000000000000", "viewer", {
      updatedAt: 2000,
      unread: true,
    }),
    ownedSession("agent:research:main", "viewer", {
      updatedAt: 1000,
      hasActiveRun: true,
      status: "running",
    }),
  ];
  // This flow follows a saved My sessions choice across agents.
  storeSidebarSessionOwnerFilter("ws://gateway.test", viewer.id, {
    ownerId: viewer.id,
    involvingMe: false,
  });
  await withOwnerSidebar(rows, [viewer, other], "personal", async ({ sidebar, context }) => {
    const visit = async (row: GatewaySessionRow, refresh = true) => {
      bindChatPageSession(context, row.key);
      sidebar.sessionKey = row.key;
      await settleLitElement(sidebar);
      if (refresh) {
        await sidebar.sessionData.refreshSidebarSessions();
        await settleLitElement(sidebar);
      }
    };
    for (const row of [rows[1]!, rows[0]!, rows[1]!]) {
      await visit(row);

      expect(context.agentSelection.state.selectedId).toBe(row.agentId);
      expect(sidebar.getRouteSessionKey()).toBe(row.key);
      expect(Boolean(sidebar.querySelector('[data-session-key="agent:main:mine"]'))).toBe(
        row.agentId === "main",
      );
      expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).toBeNull();
      expect(Boolean(sidebar.querySelector(`[data-session-key="${rows[2]!.key}"]`))).toBe(
        row.agentId === "research",
      );
    }

    await visit(rows[0]!);

    // A named owner with no sessions on the selected agent stays empty.
    await sidebar.sidebarMenus.preloadMenuRenderer();
    await selectSessionMenuValue(sidebar, "status:all");
    await selectSessionMenuValue(sidebar, "owner:other");
    await settleLitElement(sidebar);
    expect(sidebar.getRouteSessionKey()).toBe("agent:main:mine");
    expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
    await selectSessionMenuValue(sidebar, "owner:viewer");

    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    const researchMenuItem = sidebar.querySelector<HTMLElement>(
      '.sidebar-agent-menu [data-value="agent:research"]',
    )!;
    // The other agent has no loaded window under this owner/status selection.
    expect.soft(researchMenuItem.querySelector('[aria-label="Unread"]')).toBeNull();
    researchMenuItem.click();
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          pathname: "/chat/research",
        }),
      ),
    );

    await visit(rows[2]!, false);
    const home = sidebar.querySelector<HTMLElement>(".sidebar-footer-bar__home")!;
    expect.soft(home.querySelector('[aria-label="Active run"]')).not.toBeNull();

    rows[2]!.unread = false;
    await visit(rows[0]!);
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector(
        '.sidebar-agent-menu [data-value="agent:research"] [aria-label="Unread"]',
      ),
    ).toBeNull();
  });
});

it("keeps an explicitly empty route selection instead of discovering ambient Home", async () => {
  await withOwnerSidebar([], [viewer], "personal", async ({ sidebar, context }) => {
    context.gateway.snapshot.sessionKey = "agent:main:main";
    sidebar.sessionKey = "";
    await settleLitElement(sidebar);
    expect(sidebar.getRouteSessionKey()).toBe("");
  });
});
