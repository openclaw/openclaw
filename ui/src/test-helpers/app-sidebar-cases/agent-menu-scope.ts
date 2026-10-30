import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import { createGatewayHarness, createSessions, mountSidebar, TWO_AGENTS } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { sidebarDriver } from "./sidebar-driver.test-support.ts";
import "../../components/app-sidebar.tsx";

async function mountAgentMenu(agents = TWO_AGENTS, keys = ["agent:main:main"]) {
  const mounted = await mountSidebar(
    createGatewayHarness({} as GatewayBrowserClient).gateway,
    createSessions(agents.defaultId ?? "main", keys),
    "panel",
    agents,
  );
  const dom = sidebarDriver(mounted.sidebar);
  return {
    ...mounted,
    dom,
    open: async () => {
      await dom.click(".sidebar-agent-card__main, .sidebar-workspace-header__main");
      return domProbe(dom.query(".sidebar-agent-menu")!);
    },
  };
}

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps agent actions without a Show all tile with %i configured agents",
    async (count) => {
      const { dom, open } = await mountAgentMenu({
        ...TWO_AGENTS,
        agents: count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
      });
      await dom.update({ connected: true });
      const menu = await open();
      expect(menu.query('[role=searchbox], [data-value="scope:all"]')).toBeNull();
      expect(menu.all('[data-value^="agent:"]')).toHaveLength(count);
    },
  );

  it("keeps duplicate bot names without exposing internal IDs", async () => {
    const { dom, open } = await mountAgentMenu(
      {
        ...TWO_AGENTS,
        defaultId: "bot-one",
        agents: ["bot-one", "bot-two"].map((id) => ({ id, name: "New Bot" })),
      },
      ["agent:bot-one:main"],
    );
    await dom.update({ connected: true });
    await open();
    const rows = [...dom.all('[data-value^="agent:"]')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(["New Bot", "New Bot"]);
  });

  it.each(["chip", "roster"] as const)(
    "opens sessions across agents from %s mode even after selecting a page scope",
    async (mode) => {
      const { sidebar, context, dom, open } = await mountAgentMenu();
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      patchSettings({ sidebarAgentsMode: mode });
      context.agentSelection.setScope("research");
      await sidebar.updateComplete;
      const menu = await open();
      expect(menu.attr(".sidebar-agent-menu__agent-switch--active", "data-value")).toBe(
        mode === "roster" ? "scope:all" : "agent:main",
      );
      await dom.click('.sidebar-agent-menu [data-value="scope:all"]');
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("sessions");
      expect(context.agentSelection.state).toEqual({ selectedId: "main", scopeId: null });
      expect(sidebar.sidebarAgentsMode).toBe("roster");
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each(["chip", "roster"] as const)(
    "opens each agent's settings without selecting it in %s mode",
    async (mode) => {
      const { sidebar, context, dom, open } = await mountAgentMenu();
      const onNavigate = vi.fn();
      context.agentSelection.set("main");
      context.agentSelection.setScope(null);
      await dom.update({
        connected: true,
        onNavigate,
        activeRouteId: "skills",
        sidebarAgentsMode: mode,
      });
      await open();
      const gear = dom.query<HTMLButtonElement>(
        '[data-value="agent:research"] .sidebar-agent-menu__settings',
      );
      expect(gear?.getAttribute("aria-label")).toBe("research settings");
      await dom.click(gear!);
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("agents", {
        pathname: "/settings/agents/research",
      });
      expect(context.agentSelection.state).toEqual({ selectedId: "main", scopeId: null });
      expect(sidebar.sidebarAgentsMode).toBe(mode);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each(["main", "research"])(
    "chooses %s from the workspace menu and leaves roster mode",
    async (agentId) => {
      const { sidebar, context, dom, open } = await mountAgentMenu(TWO_AGENTS, [
        "agent:main:main",
        "agent:research:main",
      ]);
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      patchSettings({ sidebarAgentsMode: "roster" });
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      const menu = await open();
      expect(menu.attr(".sidebar-agent-menu__agent-switch--active", "data-value")).toBe(
        "scope:all",
      );
      await dom.click(menu.query<HTMLElement>(`[data-value="agent:${agentId}"]`)!);
      expect(sidebar.sidebarAgentsMode).toBe("chip");
      expect(sidebar.activeRouteId).toBe("skills");
      expect(context.agentSelection.state).toEqual({ selectedId: agentId, scopeId: agentId });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
      const selectedMenu = await open();
      expect(selectedMenu.attr(".sidebar-agent-menu__agent-switch--active", "data-value")).toBe(
        `agent:${agentId}`,
      );
    },
  );
});
