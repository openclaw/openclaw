import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { sessionRefFromPath } from "../../app-session-route-paths.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { settleRoster } from "./roster.test-support.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar invitation admission", () => {
  it.each([
    { field: "draggingSessionKey", value: "agent:main:task", finish: "finishSessionDrag" },
    { field: "draggingSidebarSection", value: "ungrouped", finish: "finishSidebarSectionDrag" },
    { field: "draggingSidebarEntry", value: "route:home", finish: "finishSidebarEntryDrag" },
  ] as const)(
    "waits for $field to finish even without hover or focus",
    async ({ field, value, finish }) => {
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main", "agent:main:task"]),
      );
      expect(sidebar.matches(":hover, :focus-within")).toBe(false);
      sidebar.sessionOrganizer[field] = value;
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ serverVersion: "test", communityInvite: true }));
      try {
        await context.config.refresh();
        await sidebar.updateComplete;
        expect(context.config.current.communityInvite).toBe(true);
        expect(sidebar.querySelector(".community-invite-card")).toBeNull();
        sidebar.sessionOrganizer[finish]();
        await sidebar.updateComplete;
        expect(sidebar.querySelector(".community-invite-card")).not.toBeNull();
      } finally {
        fetch.mockRestore();
      }
    },
  );
});

describe("AppSidebar new session navigation", () => {
  it("opens new-session links for the expanded agent without intercepting browser gestures", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "research" }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main", "agent:research:task"]),
      "panel",
      agentsList,
    );
    const onOpenNewSession = vi.fn();
    const onOpenPalette = vi.fn();
    const onToggleSidebar = vi.fn();
    sidebar.basePath = "/control";
    sidebar.connected = false;
    sidebar.onOpenNewSession = onOpenNewSession;
    sidebar.onOpenPalette = onOpenPalette;
    sidebar.onToggleSidebar = onToggleSidebar;
    await sidebar.updateComplete;

    const newSessionLink = sidebar.querySelector<HTMLAnchorElement>(
      ".sidebar-session-toolbar .sidebar-new-session",
    );
    expect(sidebar.querySelectorAll(".sidebar-new-session")).toHaveLength(1);
    expect(sidebar.querySelector(".sidebar-brand__collapse")).toBeNull();
    sidebar.querySelector<HTMLButtonElement>('[data-navigation-view="sessions"]')?.click();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-rail .sidebar-brand__search")?.click();
    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(onOpenPalette).toHaveBeenCalledOnce();
    expect(newSessionLink?.getAttribute("aria-label")).toBe("New conversation");
    expect(newSessionLink).toBeInstanceOf(HTMLAnchorElement);
    expect(newSessionLink?.getAttribute("aria-disabled")).toBe("true");
    expect(newSessionLink?.hasAttribute("href")).toBe(false);
    expect(newSessionLink?.tabIndex).toBe(-1);
    newSessionLink?.click();
    expect(onOpenNewSession).not.toHaveBeenCalled();

    sidebar.connected = true;
    await sidebar.updateComplete;
    const link = sidebar.querySelector<HTMLAnchorElement>(
      ".sidebar-session-toolbar .sidebar-new-session",
    )!;
    expect(link.getAttribute("aria-label")).toBe("New conversation");
    expect(link.getAttribute("href")).toBe("/control/new?agent=research");
    expect(link.hasAttribute("aria-disabled")).toBe(false);
    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(onOpenNewSession).not.toHaveBeenCalled();
    }
    link.click();
    expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("research");
    onOpenNewSession.mockClear();
  });

  it("opens a catalog-targeted draft from its new-session action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "global",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
    );
    const onOpenNewSession = vi.fn();
    sidebar.connected = true;
    sidebar.onOpenNewSession = onOpenNewSession;
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          continueSession: true,
          archive: false,
          startTerminal: true,
        },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Gateway Mac",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "local-thread",
                name: "Local plan",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const link = sidebar.querySelector<HTMLAnchorElement>(".sidebar-session-catalog-new")!;
    expect(link.getAttribute("aria-label")).toBe("New session — Claude Code");
    expect(link.getAttribute("href")).toBe("/new?agent=research&catalog=claude");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    link.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(sidebar.querySelector(".sidebar-session-catalog-view-menu")).toBeNull();
    link.click();

    expect(onOpenNewSession).toHaveBeenCalledWith("research", { catalogId: "claude" });
  });
});

describe("AppSidebar agent chip", () => {
  it("qualifies unscoped session rows with the selected agent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main", "telegram:12345"]),
      "panel",
      { ...TWO_AGENTS, defaultId: "research" },
    );
    sidebar.sessionKey = "agent:research:main";
    await sidebar.updateComplete;

    const href = sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="telegram:12345"] .sidebar-recent-session__link',
      )
      ?.getAttribute("href");
    const sessionUrl = new URL(href ?? "", window.location.origin);
    expect(sessionUrl.pathname).toBe("/chat/research/telegram/12345");
    expect(sessionUrl.search).toBe("");
    expect(sessionRefFromPath(sessionUrl.pathname)).toMatchObject({
      kind: "literal",
      sessionKey: "agent:research:telegram:12345",
    });
  });

  it("resumes the newest session when the menu switches to an agent with cached rows", async () => {
    const taskKey = "agent:main:dashboard:00000002-0000-4000-8000-000000000000";
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", taskKey]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const rows = [
      ...sidebar.querySelectorAll<HTMLElement>(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ];
    rows.find((row) => row.textContent?.includes("Molty"))?.click();
    // createSessionState stamps ascending updatedAt, so the last key is newest.
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/00000002000040008000000000000000",
      search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(taskKey)}`,
    });
  });

  it("switches the Skills owner without opening an agent conversation", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.activeRouteId = "skills";
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await sidebar.updateComplete;
    sidebar
      .querySelector<HTMLElement>('.sidebar-agent-menu wa-dropdown-item[value="agent:research"]')!
      .click();
    await sidebar.updateComplete;

    expect(context.agentSelection.state).toEqual({
      selectedId: "research",
      scopeId: "research",
    });
    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent).toContain("research");
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps agent ids distinct from utility command values", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "settings" }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      agents,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsAgent = menu?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="agent:settings"]',
    );
    expect(settingsAgent).not.toBeNull();
    settingsAgent!.click();
    await sidebar.updateComplete;

    // Uncached agent main session: the face is a guess, so the navigation carries the
    // marker that lets the chat loader re-derive it from the gateway.
    expect(setSessionKey).toHaveBeenCalledWith("agent:settings:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/settings",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(onNavigate).not.toHaveBeenCalledWith("appearance");
  });

  it("keeps the identity card available offline with reconnect and retry actions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const onRetryConnect = vi.fn();
    sidebar.onRetryConnect = onRetryConnect;
    sidebar.connected = true;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-card__main")).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-workspace-header__main")?.getAttribute("aria-label"),
    ).not.toContain("Online");

    sidebar.connected = false;
    sidebar.connectionStatus = "reconnecting";
    await sidebar.updateComplete;
    const card = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(card?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe("Owner");
    expect(card?.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    const connectionStatus = sidebar.querySelector(".gateway-status");
    expect(
      sidebar.querySelector('.sidebar-footer-bar > [role="status"]')?.getAttribute("aria-live"),
    ).toBe("polite");
    expect(connectionStatus?.textContent).not.toContain("Offline");
    expect(connectionStatus?.textContent).toContain("Reconnecting…");
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();

    card?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const retry = menu?.querySelector('wa-dropdown-item[value="command:retry-connect"]');
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: retry }, bubbles: true }));
    expect(onRetryConnect).toHaveBeenCalledOnce();

    sidebar.connectionStatus = null;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".gateway-status")).toBeNull();
  });

  it("keeps the sessions list flat for the selected agent and flags other-agent unread", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions, "panel", TWO_AGENTS);
    sidebar.connected = true;
    const defaults = { modelProvider: null, model: null, contextTokens: null };
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults,
        sessions: [
          {
            key: "agent:research:one",
            kind: "direct",
            label: "Research task",
            updatedAt: 3,
            unread: true,
          },
        ],
      },
      agentId: "research",
    });
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults,
        sessions: [{ key: "agent:main:main", kind: "direct", label: "Main task", updatedAt: 5 }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    // No per-agent sections: the card switcher owns agent switching now, and
    // the main session lives behind the identity card instead of the list.
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-section")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(
      sidebar.querySelector(".sidebar-agent-card__avatar .sidebar-agent-card__menu-unread"),
    ).not.toBeNull();

    // Mid-switch (selected agent != loaded result agent) the list renders the
    // target agent's cached rows instead of flashing empty until refresh.
    // Chip switch and chat-pane both sync agentSelection with the route.
    context.agentSelection.state.selectedId = "research";
    sidebar.sessionKey = "agent:research:one";
    await sidebar.updateComplete;
    const rows = [...sidebar.querySelectorAll(".sidebar-recent-session")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Research task");
  });

  it("routes the agent header to its main session and marks it active there", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gateway as { setSessionKey: (key: string) => void }).setSessionKey = setSessionKey;
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    sidebar.connected = true;
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:main";
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    const home = sidebar.querySelector<HTMLAnchorElement>('[data-agent-id="main"]');
    expect(home).not.toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-footer-bar__home")).toHaveLength(1);
    expect(home?.getAttribute("aria-current")).toBe("page");

    home?.click();
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main" });
  });

  it("treats the global key as the main session under global scope", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["global"]);
    const globalAgents = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", identity: { name: "Molty" } }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(gateway, harness.sessions, "panel", globalAgents);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "global", kind: "global", updatedAt: 5, unread: true },
          { key: "agent:main:side-quest", kind: "direct", label: "Side quest", updatedAt: 4 },
        ],
      },
    });
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    // Main navigation and its unread state belong to the agent header, not a duplicate row.
    expect(sidebar.querySelector('[data-session-key="global"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:side-quest"]')).not.toBeNull();
    expect(
      sidebar.querySelector(
        '[data-agent-group=main] .sidebar-agent-roster__header [aria-label="Unread"]',
      ),
    ).not.toBeNull();
  });

  it("keeps main-session activity on its agent header without duplicate main or subagent rows", async () => {
    const key = "main";
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [key]);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions, "panel", {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", identity: { name: "Molty" } }],
    });
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key,
            kind: "direct",
            label: "[OpenClaw heartbeat poll]",
            category: "Team",
            pinned: false,
            updatedAt: 5,
            childSessions: ["agent:main:subagent:thread-a"],
          },
          {
            key: "agent:main:subagent:thread-a",
            spawnedBy: key,
            kind: "direct",
            label: "Spawned thread",
            updatedAt: 4,
            hasActiveRun: true,
            status: "running",
          },
        ],
      },
    });
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    expect(sidebar.querySelectorAll('[data-agent-id="main"][href="/chat/main"]')).toHaveLength(1);
    expect(sidebar.querySelector(`[data-session-key="${key}"]`)).toBeNull();
    expect(sidebar.querySelector(`[data-child-session-toggle="${key}"]`)).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:subagent:thread-a"]')).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-agent-group=main] .sidebar-agent-roster__header .session-glyph__ring[aria-label="Active run"]',
      ),
    ).not.toBeNull();

    const result = harness.sessions.state.result!;
    harness.publishList({
      result: {
        ...result,
        ts: 3,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:subagent:thread-a"
            ? Object.assign({}, row, {
                hasActiveRun: false,
                status: "failed",
                endedAt: 6,
                updatedAt: 6,
                lastRunError: "Review failed",
              })
            : row,
        ),
      },
    });
    await rosterActivityStore(context).refresh();
    await settleRoster(sidebar);
    expect(
      sidebar.querySelectorAll("[data-agent-group=main] .sidebar-agent-roster__header"),
    ).toHaveLength(1);
    expect(sidebar.querySelector(`[data-session-key="${key}"]`)).toBeNull();
    expect(
      sidebar.querySelector(
        "[data-agent-group=main] .sidebar-agent-roster__header .session-glyph__ring",
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-agent-group=main] .sidebar-agent-roster__header [data-session-attention="error"]',
      ),
    ).not.toBeNull();
    expect(
      sidebar.querySelector("[data-agent-group=main] .sidebar-agent-roster__header")?.textContent,
    ).toContain("Child session Spawned thread failed: Review failed");
  });
});
