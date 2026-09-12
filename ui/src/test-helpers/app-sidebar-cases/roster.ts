import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  agentIds,
  mountRoster,
  roster,
  selectFilter,
  session,
  sessionKeys,
  toggleRoster,
} from "./roster.test-support.ts";

describe("AppSidebar agent roster", () => {
  it.each([undefined, "Studio workspace", "   "])(
    "shows workspace identity for configured name %s and restores the agent chip",
    async (name) => {
      if (name !== undefined) {
        vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", true);
        vi.stubGlobal("__OPENCLAW_NATIVE_GATEWAYS__", {
          currentId: "studio",
          gateways: [{ id: "studio", name, isPrimary: true, health: "ok" }],
        });
      }
      try {
        const { sidebar } = await mountRoster();
        await toggleRoster(sidebar);
        await vi.waitFor(() =>
          expect(sidebar.querySelector(".sidebar-workspace-header__main")).not.toBeNull(),
        );
        const header = sidebar.querySelector(".sidebar-workspace-header");
        expect(header?.textContent).toContain(name?.trim() || "OpenClaw");
        expect(header?.querySelector(".sidebar-agent-card__avatar")).toBeNull();
        expect(header?.querySelector("img")?.getAttribute("src")).toBe("/favicon.svg");
        expect(sidebar.querySelector("openclaw-sidebar-agent-card")).toBeNull();
        sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
        await vi.waitFor(() => expect(sidebar.querySelector(".sidebar-agent-menu")).not.toBeNull());
        const menu = sidebar.querySelector(".sidebar-agent-menu");
        expect(
          [...(menu?.querySelectorAll(":scope > wa-dropdown-item") ?? [])].map((item) =>
            item.textContent?.trim(),
          ),
        ).toEqual(["Show one agent", "Agent settings", expect.stringContaining("Help")]);
        expect(menu?.querySelector(".sidebar-agent-menu__agent-grid")).toBeNull();
        expect(
          [...(menu?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href")),
        ).toEqual([
          "https://docs.openclaw.ai",
          "https://docs.openclaw.ai/help",
          "https://discord.gg/clawd",
          "https://docs.openclaw.ai/releases",
        ]);
        menu?.dispatchEvent(
          new CustomEvent("wa-select", {
            detail: { item: menu.querySelector('[value="command:sidebar-agents"]') },
            bubbles: true,
          }),
        );
        await vi.waitFor(() =>
          expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain(
            "Harbor",
          ),
        );
        expect(sidebar.querySelector(".sidebar-workspace-header")).toBeNull();
        sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
        await vi.waitFor(() =>
          expect(sidebar.querySelector('[value="command:sidebar-agents"]')?.textContent).toContain(
            "Show all agents",
          ),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps configured agent order when session activity changes", async () => {
    const { sidebar, context, result } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]));
    for (const id of ["main", "recent", "working"]) {
      const group = sidebar.querySelector<HTMLElement>(`[data-agent-group="${id}"]`);
      if (!group) {
        throw new Error(`Missing session group for ${id}`);
      }
      await vi.waitFor(() =>
        expect(sessionKeys(group)).toEqual([
          `agent:${id}:pinned`,
          `agent:${id}:main`,
          `agent:${id}:recent`,
        ]),
      );
      expect(group?.querySelector(`a[href="/new?agent=${id}"]`)).not.toBeNull();
      expect(group?.querySelector(".sidebar-agent-roster__row")?.getAttribute("href")).toBe(
        `/chat/${id}`,
      );
    }
    expect(sidebar.querySelector('[data-agent-id="working"]')?.textContent?.trim()).toBe("Forge");
    expect(sidebar.querySelector(".sidebar-agent-roster__status")).toBeNull();
    expect(sidebar.querySelector('[data-agent-id="recent"]')?.textContent?.trim()).toBe("Scout");
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:working:pinned"] .sidebar-session-team-state .session-glyph__ring',
      ),
    ).not.toBeNull();
    expect(
      sidebar.querySelector('[data-session-key="agent:main:recent"] .session-unread-dot'),
    ).not.toBeNull();
    expect(sidebar.querySelector("openclaw-sidebar-agent-card")).toBeNull();
    result.sessions = result.sessions.map((row) =>
      Object.assign({}, row, {
        hasActiveRun: row.agentId === "recent",
        updatedAt: row.agentId === "recent" ? 999 : 1,
      }),
    );
    await rosterActivityStore(context).refresh();
    expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
  });

  it("switches active agent when a grouped session or main chat is opened", async () => {
    const { sidebar, context } = await mountRoster();
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    expect(sidebar.querySelector(".nav-item--home")).not.toBeNull();
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:working:recent"));
    expect(sidebar.querySelector(".nav-item--home")).toBeNull();
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="recent"]')?.click();
    await vi.waitFor(() => expect(sessionKeys(sidebar)).not.toContain("agent:recent:recent"));
    expect(onNavigate).not.toHaveBeenCalled();
    sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="agent:working:recent"] .sidebar-recent-session__link',
      )
      ?.click();
    await vi.waitFor(() =>
      expect(context.agentSelection.state).toEqual({ selectedId: "working", scopeId: null }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working/recent" }),
    );
    expect(sidebar.querySelector(".sidebar-workspace-header__main")?.textContent).toContain(
      "OpenClaw",
    );
    expect(sidebar.querySelector("openclaw-sidebar-agent-card")).toBeNull();
    sidebar
      .querySelector<HTMLAnchorElement>('[data-agent-group="recent"] .sidebar-agent-roster__row')
      ?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("recent"));
    expect(onNavigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/recent" }),
    );
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(sidebar.querySelector(".nav-item--home")).not.toBeNull());
    expect(context.agentSelection.state.scopeId).toBe("main");
  });

  it("offers new sessions for agents in group order from the brand menu", async () => {
    const { sidebar } = await mountRoster();
    const onOpen = vi.fn();
    sidebar.onOpenNewSession = onOpen;
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    const menus = sidebar.querySelectorAll(".sidebar-new-session-menu");
    expect(menus).toHaveLength(1);
    for (const menu of menus) {
      const options = [...menu.querySelectorAll("wa-dropdown-item")];
      expect(options.map((item) => item.getAttribute("value"))).toEqual(agentIds(sidebar));
      expect(options.map((item) => item.querySelector("a")?.getAttribute("href"))).toEqual(
        agentIds(sidebar).map((id) => `/new?agent=${id}`),
      );
      expect(options[0]?.textContent).toContain("Harbor");
      await vi.waitFor(() =>
        expect(options[2]?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
      );
    }
    menus[0]?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: menus[0].querySelector('[value="recent"]') },
        bubbles: true,
      }),
    );
    expect(onOpen).toHaveBeenCalledWith("recent");
  });

  it.each([undefined, "main"])(
    "opens an unprefixed default-agent session from another group (agentId=%s)",
    async (agentId) => {
      const { sidebar, context, sessions } = await mountRoster(roster, [
        session("working", 3, { key: "agent:working:task", isMain: false }),
        {
          key: "legacy-task",
          kind: "direct",
          updatedAt: 2,
          agentId,
          hasActiveRun: true,
          unread: true,
        },
      ]);
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => {
        expect(agentIds(sidebar)).toHaveLength(3);
        expect(sessionKeys(sidebar)).toContain("agent:working:task");
        expect(
          sidebar.querySelector(
            '[data-session-key="legacy-task"] .sidebar-session-team-state .session-glyph__ring',
          ),
        ).not.toBeNull();
        expect(
          sidebar.querySelector(
            '[data-session-key="legacy-task"] .sidebar-session-team-state .session-unread-dot',
          ),
        ).not.toBeNull();
      });
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="agent:working:task"] .sidebar-recent-session__link',
        )
        ?.click();
      await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("working"));
      sidebar.sessionKey = "agent:working:task";
      await sidebar.updateComplete;
      sidebar
        .querySelector<HTMLButtonElement>('[data-session-key="legacy-task"] .session-action--pin')
        ?.click();
      await vi.waitFor(() =>
        expect(sessions.patch).toHaveBeenCalledWith(
          "legacy-task",
          { pinned: true },
          expect.objectContaining({ agentId: "main" }),
        ),
      );
      expect(context.agentSelection.state.selectedId).toBe("working");
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="legacy-task"] .sidebar-recent-session__link',
        )
        ?.click();
      await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("main"));
      expect(onNavigate).toHaveBeenLastCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/main/legacy-task" }),
      );
    },
  );

  it("groups an unprefixed session by its row agent and navigates to that same agent", async () => {
    const { sidebar, context, sessions } = await mountRoster(roster, [
      {
        key: "legacy-task",
        kind: "direct",
        agentId: "working",
        label: "Existing work",
        updatedAt: 2,
      },
      session("working", 1, { key: "agent:working:older", isMain: false }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await selectFilter(sidebar, "sort:updated");
    await vi.waitFor(() => {
      expect(
        sidebar.querySelector('[data-agent-group="working"] [data-session-key="legacy-task"]'),
      ).not.toBeNull();
      expect(
        [
          ...sidebar.querySelectorAll<HTMLElement>(
            '[data-agent-group="working"] [data-session-key]',
          ),
        ].map((row) => row.dataset.sessionKey),
      ).toEqual(["legacy-task", "agent:working:older"]);
      expect(
        sidebar.querySelector('[data-agent-group="main"] [data-session-key="legacy-task"]'),
      ).toBeNull();
    });
    const link = sidebar.querySelector<HTMLAnchorElement>(
      '[data-session-key="legacy-task"] .sidebar-recent-session__link',
    );
    expect(link?.pathname).toBe("/chat/working/legacy-task");
    sidebar
      .querySelector<HTMLButtonElement>('[data-session-key="legacy-task"] .session-action--pin')
      ?.click();
    await vi.waitFor(() =>
      expect(sessions.patch).toHaveBeenCalledWith(
        "legacy-task",
        { pinned: true },
        expect.objectContaining({ agentId: "working" }),
      ),
    );
    expect(context.agentSelection.state.selectedId).toBe("main");
    link?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("working"));
  });

  it("restores each Gateway's own collapsed groups when the context changes", async () => {
    const { sidebar, provider } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
    await vi.waitFor(() =>
      expect(loadSettings("ws://gateway.test").sidebarCollapsedAgentIds).toEqual(["working"]),
    );
    patchSettings({ gatewayUrl: "ws://second.test", sidebarCollapsedAgentIds: ["recent"] });
    const replacement = await mountRoster(roster, undefined, "ws://second.test");
    provider.setContext(replacement.context);
    replacement.provider.remove();
    await vi.waitFor(() => {
      expect(
        sidebar.querySelector('[data-agent-collapse="working"]')?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        sidebar.querySelector('[data-agent-collapse="recent"]')?.getAttribute("aria-expanded"),
      ).toBe("false");
    });
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="main"]')?.click();
    await vi.waitFor(() =>
      expect(loadSettings("ws://second.test").sidebarCollapsedAgentIds).toEqual(["recent", "main"]),
    );
    expect(loadSettings("ws://gateway.test").sidebarCollapsedAgentIds).toEqual(["working"]);
  });

  it.each(["outside the window", "archived", "archived child", "child of main"])(
    "keeps a directly opened session visible when %s",
    async (variant) => {
      const key = "agent:working:older";
      const parentKey = variant === "child of main" ? "agent:main:main" : "agent:main:parent";
      const current = session("working", 1, {
        key,
        isMain: false,
        label: "Opened conversation",
        archived: variant === "archived" || variant === "archived child",
        ...(["archived child", "child of main"].includes(variant) ? { spawnedBy: parentKey } : {}),
      });
      const parent = session("main", 0, {
        key: parentKey,
        isMain: variant === "child of main",
        archived: variant !== "child of main",
        childSessions: [key],
      });
      const bounded = [
        session("main", 10, { key: "agent:main:recent", isMain: false }),
        ...(variant === "outside the window" ? [] : [current, parent]),
      ];
      const { sidebar, context } = await mountRoster(roster, bounded, undefined, [current, parent]);
      sidebar.sidebarAgentsMode = "roster";
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      context.agentSelection.set("working");
      await vi.waitFor(() => {
        const rows = sidebar.querySelectorAll(`[data-session-key="${key}"]`);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.classList.contains("sidebar-recent-session--active")).toBe(true);
      });
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`) !== null).toBe(
        variant === "child of main",
      );
    },
  );

  it("shows every agent beyond six with the global filter in the header", async () => {
    const agents: AgentsListResult = {
      ...roster,
      agents: Array.from({ length: 8 }, (_, index) => ({ id: `agent-${index}` })),
    };
    const { sidebar } = await mountRoster(
      agents,
      agents.agents.map((agent, index) =>
        session(agent.id, index + 1, { hasActiveRun: index === 0 }),
      ),
    );
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(agentIds(sidebar)).toEqual(agents.agents.map((agent) => agent.id)),
    );
    expect(sidebar.querySelector(".sidebar-session-toolbar")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-brand__actions .sidebar-session-sort")).toHaveLength(
      1,
    );
    expect(sidebar.querySelector(".sidebar-sessions .sidebar-session-sort")).toBeNull();
  });

  it("remembers collapsed agents after remount and keeps chip mode scoped to one agent", async () => {
    const { sidebar, provider } = await mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
    await vi.waitFor(() => expect(sessionKeys(sidebar)).not.toContain("agent:working:pinned"));
    expect(loadSettings().sidebarCollapsedAgentIds).toEqual(["working"]);
    provider.remove();
    const remounted = await mountRoster();
    remounted.sidebar.sidebarAgentsMode = loadSettings().sidebarAgentsMode ?? "chip";
    await vi.waitFor(() => expect(agentIds(remounted.sidebar)).toHaveLength(3));
    expect(
      remounted.sidebar
        .querySelector('[data-agent-collapse="working"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(sessionKeys(remounted.sidebar)).not.toContain("agent:working:recent");
    expect(sessionKeys(remounted.sidebar)).toContain("agent:recent:recent");
    await toggleRoster(remounted.sidebar);
    await vi.waitFor(() =>
      expect(remounted.sidebar.querySelector(".sidebar-agent-roster")).toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(sessionKeys(remounted.sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
  });

  it("applies owner and archived filters across all agent groups", async () => {
    const { sidebar } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toHaveLength(9));
    await selectFilter(sidebar, "owner:profile-ada");
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual([
        "agent:main:pinned",
        "agent:recent:pinned",
        "agent:working:pinned",
      ]),
    );
    await selectFilter(sidebar, "status:archived");
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual([
        "agent:main:archived",
        "agent:recent:archived",
        "agent:working:archived",
      ]),
    );
    expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
  });

  it("filters archived children while keeping main-session children nested", async () => {
    const { sidebar } = await mountRoster(roster, [
      session("working", 10, { childSessions: ["agent:working:main-child"] }),
      session("working", 9, {
        key: "agent:working:parent",
        isMain: false,
        childSessions: ["agent:working:archived-child"],
      }),
      session("working", 8, {
        key: "agent:working:archived-child",
        isMain: false,
        spawnedBy: "agent:working:parent",
        category: "Saved work",
        archived: true,
      }),
      session("working", 7, {
        key: "agent:working:main-child",
        isMain: false,
        spawnedBy: "agent:working:main",
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual(["agent:working:main", "agent:working:parent"]),
    );
    expect(sidebar.querySelector('[data-child-session-toggle="agent:working:parent"]')).toBeNull();
    sidebar
      .querySelector<HTMLButtonElement>('[data-child-session-toggle="agent:working:main"]')
      ?.click();
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:working:main-child"));
    await selectFilter(sidebar, "status:archived");
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual(["agent:working:archived-child"]));
  });

  it("keeps a group's expanded page when selecting a session in another group", async () => {
    const count = SIDEBAR_SESSION_PAGE_SIZE + 2;
    const { sidebar, context } = await mountRoster(roster, [
      ...Array.from({ length: count }, (_, index) =>
        session("working", count - index, {
          key: `agent:working:thread-${index}`,
          isMain: false,
        }),
      ),
      session("recent", 1, { key: "agent:recent:notes", isMain: false }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    const group = () => sidebar.querySelector<HTMLElement>('[data-agent-group="working"]');
    await vi.waitFor(() =>
      expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(
        SIDEBAR_SESSION_PAGE_SIZE,
      ),
    );
    group()?.querySelector<HTMLButtonElement>('[aria-label="Show more"]')?.click();
    await vi.waitFor(() =>
      expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(count),
    );
    sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="agent:recent:notes"] .sidebar-recent-session__link',
      )
      ?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("recent"));
    await sidebar.updateComplete;
    expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(count);
  });
});
