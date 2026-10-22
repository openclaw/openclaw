import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { patchSettings } from "../../app/settings.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps agent actions without a Show all tile with %i configured agents",
    async (count) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu");
      expect(menu?.querySelector("[role=searchbox]")).toBeNull();
      expect(menu?.querySelector('[data-value="scope:all"]')).toBeNull();
      expect(menu?.querySelectorAll('[data-value^="agent:"]')).toHaveLength(count);
      expect(
        [...(menu?.querySelectorAll(':scope > [role^="menuitem"]') ?? [])].map((element) =>
          element.getAttribute("data-value"),
        ),
      ).toEqual(["command:new-agent"]);
    },
  );

  it("keeps duplicate bot names without exposing internal IDs", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("bot-one", ["agent:bot-one:main"]),
      "panel",
      {
        defaultId: "bot-one",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "bot-one", name: "New Bot" },
          { id: "bot-two", name: "New Bot" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const rows = [...sidebar.querySelectorAll('[data-value^="agent:"]')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(["New Bot", "New Bot"]);
    expect(rows.every((row) => !row.querySelector(".agent-select__option-description"))).toBe(true);
  });

  it.each(["chip", "roster"] as const)(
    "opens sessions across agents from %s mode even after selecting a page scope",
    async (mode) => {
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      patchSettings({ sidebarAgentsMode: mode });
      context.agentSelection.setScope("research");
      await sidebar.updateComplete;
      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="scope:all"]')?.click();
      await sidebar.updateComplete;
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("sessions");
      expect(context.agentSelection.state).toEqual({ selectedId: "main", scopeId: null });
      expect(sidebar.sidebarAgentsMode).toBe("roster");
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each(["chip", "roster"] as const)(
    "opens each agent's settings without selecting it in %s mode",
    async (mode) => {
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      context.agentSelection.set("main");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;
      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const gear = sidebar.querySelector<HTMLButtonElement>(
        '[data-value="agent:research"] .sidebar-agent-menu__settings',
      );
      expect(gear?.getAttribute("aria-label")).toBe("research settings");
      gear?.click();
      await sidebar.updateComplete;
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
      const { sidebar, context } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main", "agent:research:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      patchSettings({ sidebarAgentsMode: "roster" });
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
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
    const { sidebar, context } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.activeRouteId = "skills";
    context.agentSelection.set("research");
    context.agentSelection.setScope(null);
    await sidebar.updateComplete;
    for (const mode of ["chip", "roster"] as const) {
      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("data-value"),
      ).toBe(mode === "roster" ? "scope:all" : "agent:research");
      expect(
        menu.querySelector(
          '[aria-checked], .session-menu__check, [data-value="command:all-agents"]',
        ),
      ).toBeNull();
      expect(
        [...menu.querySelectorAll('[data-value^="command:"]')].map((item) =>
          item.getAttribute("data-value"),
        ),
      ).toEqual(["command:new-agent"]);
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
