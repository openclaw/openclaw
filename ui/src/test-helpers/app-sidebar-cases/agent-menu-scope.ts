import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { createGateway, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import { agentList } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

function mountMenu(agents = TWO_AGENTS, keys = ["agent:main:main"]) {
  return mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", keys),
    "panel",
    agents,
  );
}

async function openMenu(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"]) {
  sidebar
    .querySelector<HTMLElement>(".sidebar-agent-card__main, .sidebar-workspace-header__main")
    ?.click();
  await sidebar.updateComplete;
  return sidebar.querySelector(".sidebar-agent-menu")!;
}

function commandValues(menu: Element, selector = '[data-value^="command:"]') {
  return [...menu.querySelectorAll(selector)].map((item) => item.getAttribute("data-value"));
}

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps agent actions without a Show all tile with %i configured agents",
    async (count) => {
      const { sidebar } = await mountMenu(
        agentList(count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }]),
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      const menu = await openMenu(sidebar);
      expect(menu?.querySelector(".sidebar-agent-menu__filter")).toBeNull();
      expect(menu?.querySelector('[data-value="scope:all"]')).toBeNull();
      expect(menu?.querySelectorAll('[data-value^="agent:"]')).toHaveLength(count);
      expect(commandValues(menu, ':scope > [role^="menuitem"]')).toEqual([
        "command:new-agent",
        "command:agents-directory",
        ...(count ? ["command:capabilities"] : []),
        "command:agent-settings",
      ]);
    },
  );

  it.each(
    (["chip", "roster"] as const).flatMap((mode) => [
      {
        mode,
        value: "agents-directory",
        label: "See all agents",
        route: "agents-home",
        options: undefined,
      },
      {
        mode,
        value: "agent-settings",
        label: "research settings",
        route: "agents",
        options: { pathname: "/settings/agents/research" },
      },
    ]),
  )(
    "opens $label without changing the agent, scope, or $mode mode",
    async ({ mode, value, label, route, options }) => {
      const { sidebar, context } = await mountMenu();
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      sidebar.activeRouteId = "skills";
      context.agentSelection.set("research");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;
      await openMenu(sidebar);
      const item = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [data-value="command:' + value + '"]',
      );
      expect(item?.textContent?.trim()).toBe(label);
      expect(item?.hasAttribute("aria-checked")).toBe(false);
      item?.click();
      await sidebar.updateComplete;
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(route, options);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: null });
      expect(sidebar.sidebarAgentsMode).toBe(mode);
    },
  );

  it.each(["main", "research"])(
    "chooses %s from the workspace menu and leaves roster mode",
    async (agentId) => {
      const { sidebar, context } = await mountMenu(TWO_AGENTS, [
        "agent:main:main",
        "agent:research:main",
      ]);
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      patchSettings({ sidebarAgentsMode: "roster" });
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      const menu = await openMenu(sidebar);
      expect(menu.querySelector("[aria-checked], .session-menu__check")).toBeNull();
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("data-value"),
      ).toBe("scope:all");
      expect(
        menu.querySelector('[data-value="command:help"], [data-value="command:all-agents"]'),
      ).toBeNull();
      menu.querySelector<HTMLElement>(`[data-value="agent:${agentId}"]`)?.click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarAgentsMode).toBe("chip");
      expect(sidebar.activeRouteId).toBe("skills");
      expect(context.agentSelection.state).toEqual({ selectedId: agentId, scopeId: agentId });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
    },
  );

  it("moves the scope ring between the active agent and Show all", async () => {
    const { sidebar, context } = await mountMenu();
    sidebar.activeRouteId = "skills";
    context.agentSelection.set("research");
    context.agentSelection.setScope(null);
    await sidebar.updateComplete;
    for (const mode of ["chip", "roster"] as const) {
      const menu = await openMenu(sidebar);
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("data-value"),
      ).toBe(mode === "roster" ? "scope:all" : "agent:research");
      expect(
        menu.querySelector(
          '[aria-checked], .session-menu__check, [data-value="command:all-agents"]',
        ),
      ).toBeNull();
      expect(commandValues(menu)).toEqual([
        "command:new-agent",
        "command:agents-directory",
        "command:capabilities",
        "command:agent-settings",
      ]);
      menu
        .querySelector<HTMLElement>(
          mode === "chip" ? '[data-value="scope:all"]' : '[data-value="agent:research"]',
        )
        ?.click();
      await vi.waitFor(() =>
        expect(sidebar.sidebarAgentsMode).toBe(mode === "chip" ? "roster" : "chip"),
      );
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(context.agentSelection.state.selectedId).toBe("research");
    }
  });
});
