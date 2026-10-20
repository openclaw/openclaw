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
  catalogPage,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { agentList, sessionList } from "./compact.test-support.ts";
import { settleRoster } from "./roster.test-support.ts";
import "../../components/app-sidebar.tsx";

await import("../../components/viewer-facepile.ts");

function mountAgentSidebar(
  sessions = createSessions("main", ["agent:main:main"]),
  agents: AgentsListResult | null = TWO_AGENTS,
  gateway = createGateway({} as GatewayBrowserClient),
) {
  return mountSidebar(gateway, sessions, "panel", agents);
}

async function clickAgentMenu(
  sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"],
  value?: string,
) {
  const selector = value
    ? `.sidebar-agent-menu [data-value="${value}"]`
    : ".sidebar-agent-card__main";
  sidebar.querySelector<HTMLElement>(selector)!.click();
  await sidebar.updateComplete;
}

async function mountNavigation(
  sessions?: Parameters<typeof mountAgentSidebar>[0],
  agents?: AgentsListResult,
) {
  const gateway = createGateway({} as GatewayBrowserClient);
  const setSessionKey = vi.fn();
  (gateway as { setSessionKey: (key: string) => void }).setSessionKey = setSessionKey;
  const mounted = await mountAgentSidebar(sessions, agents, gateway);
  const onNavigate = vi.fn();
  mounted.sidebar.connected = true;
  mounted.sidebar.onNavigate = onNavigate;
  return { ...mounted, setSessionKey, onNavigate };
}

describe("AppSidebar community entry", () => {
  it("follows the deployment flag without using the old invitation dismissal", async () => {
    const { sidebar, context } = await mountAgentSidebar(undefined, null);
    localStorage.setItem("openclaw:control-ui:community-invite:v2", "dismissed");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      for (const enabled of [true, false]) {
        fetch.mockResolvedValue(Response.json({ serverVersion: "test", communityInvite: enabled }));
        await context.config.refresh();
        await sidebar.updateComplete;
        expect(Boolean(sidebar.querySelector(".sidebar-community__entry"))).toBe(enabled);
      }
    } finally {
      fetch.mockRestore();
      localStorage.removeItem("openclaw:control-ui:community-invite:v2");
    }
  });
});

describe("AppSidebar new session navigation", () => {
  it.each(["chip", "roster"] as const)(
    "opens new-session links directly in %s mode without intercepting browser gestures",
    async (mode) => {
      const { sidebar } = await mountAgentSidebar(
        createSessions("research", ["agent:research:main", "agent:research:task"]),
        agentList([{ id: "main" }, { id: "research" }]),
      );
      const onOpenNewSession = vi.fn();
      const onOpenPalette = vi.fn();
      const onToggleSidebar = vi.fn();
      sidebar.basePath = "/control";
      sidebar.sidebarAgentsMode = mode;
      sidebar.connected = false;
      sidebar.onOpenNewSession = onOpenNewSession;
      sidebar.onOpenPalette = onOpenPalette;
      sidebar.onToggleSidebar = onToggleSidebar;
      await sidebar.updateComplete;
      await settleRoster(sidebar);

      const newSessionLink = sidebar.querySelector<HTMLAnchorElement>(
        ".sidebar-rail .sidebar-new-session",
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
      const link = sidebar.querySelector<HTMLAnchorElement>(".sidebar-rail .sidebar-new-session")!;
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
      for (const view of ["pages", "sessions", "online"] as const) {
        for (const collapsed of [false, true]) {
          sidebar.navigationView = view;
          sidebar.navigationCollapsed = collapsed;
          await sidebar.updateComplete;
          const current = sidebar.querySelector<HTMLAnchorElement>(
            ".sidebar-rail .sidebar-new-session",
          );
          expect(current).toBe(link);
          expect(sidebar.querySelectorAll(".sidebar-new-session")).toHaveLength(1);
          expect(sidebar.querySelector(".sidebar-session-toolbar .sidebar-new-session")).toBeNull();
          current!.click();
          expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("research");
          onOpenNewSession.mockClear();
        }
      }
    },
  );

  it("opens a catalog-targeted draft from its new-session action", async () => {
    const { sidebar } = await mountAgentSidebar(
      createSessions("research", ["agent:research:main"]),
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
    const catalog = catalogPage(
      [{ threadId: "local-thread", name: "Local plan" }],
      undefined,
      "claude",
    ).catalogs[0]!;
    catalog.label = "Claude Code";
    catalog.capabilities = { continueSession: true, archive: false, startTerminal: true };
    catalog.hosts[0]!.label = "Gateway Mac";
    Object.assign(catalog.hosts[0]!.sessions[0]!, { status: "stored", canArchive: false });
    sidebar.sessionData.sessionCatalogs = [catalog];
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
    const { sidebar } = await mountAgentSidebar(
      createSessions("research", ["agent:research:main", "telegram:12345"]),
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
    const { sidebar, setSessionKey, onNavigate } = await mountNavigation(
      createSessions("main", ["agent:main:main", taskKey]),
    );
    await sidebar.updateComplete;

    await clickAgentMenu(sidebar);
    const rows = [
      ...sidebar.querySelectorAll<HTMLElement>(
        ".sidebar-agent-menu .sidebar-agent-menu__agent-switch",
      ),
    ];
    rows.find((row) => row.textContent?.includes("Molty"))?.click();
    await sidebar.updateComplete;
    // createSessionState stamps ascending updatedAt, so the last key is newest.
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/00000002000040008000000000000000",
      search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(taskKey)}`,
    });
  });

  it("switches the Skills owner without opening an agent conversation", async () => {
    const { sidebar, context } = await mountAgentSidebar();
    const onNavigate = vi.fn();
    sidebar.activeRouteId = "skills";
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    await clickAgentMenu(sidebar);
    await clickAgentMenu(sidebar, "agent:research");

    expect(context.agentSelection.state).toEqual({
      selectedId: "research",
      scopeId: "research",
    });
    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent).toContain("research");
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps agent ids distinct from utility command values", async () => {
    const { sidebar, setSessionKey, onNavigate } = await mountNavigation(
      undefined,
      agentList([{ id: "main" }, { id: "settings" }]),
    );
    await sidebar.updateComplete;

    await clickAgentMenu(sidebar);
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsAgent = menu?.querySelector<HTMLElement>('[data-value="agent:settings"]');
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
    const { sidebar } = await mountAgentSidebar(undefined, null);
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
    expect(sidebar.querySelector(".gateway-status")).toBeNull();
    expect(card?.getAttribute("data-connection-status")).toBe("reconnecting");
    expect(card?.querySelector(".sidebar-identity-card__status")).not.toBeNull();
    expect(card?.getAttribute("aria-label")).toBe("Identity and app menu for Owner: Reconnecting…");
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();

    card?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const retry = menu?.querySelector<HTMLElement>('[data-value="command:retry-connect"]');
    retry?.click();
    await vi.waitFor(() => expect(onRetryConnect).toHaveBeenCalledOnce());

    sidebar.connectionStatus = null;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".gateway-status")).toBeNull();
    expect(card?.getAttribute("data-connection-status")).toBeNull();
  });

  it("keeps the sessions list flat for the selected agent and flags other-agent unread", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar, context } = await mountAgentSidebar(harness.sessions);
    sidebar.connected = true;
    const researchSnapshot = {
      result: sessionList([
        {
          key: "agent:research:one",
          kind: "direct",
          label: "Research task",
          updatedAt: 3,
          unread: true,
        },
      ]),
      agentId: "research",
    } satisfies Parameters<typeof harness.publishList>[0];
    const mainSnapshot = {
      result: sessionList(
        [{ key: "agent:main:main", kind: "direct", label: "Main task", updatedAt: 5 }],
        3,
      ),
      agentId: "main",
    } satisfies Parameters<typeof harness.publishList>[0];
    harness.publishList(researchSnapshot);
    harness.publishList(mainSnapshot);
    await sidebar.updateComplete;

    // No per-agent sections: the card switcher owns agent switching now, and
    // the main session lives behind the identity card instead of the list.
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-section")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(
      sidebar.querySelector(".sidebar-agent-card__avatar .sidebar-agent-card__menu-unread"),
    ).not.toBeNull();

    // Retire the previous agent scope through its owner before seeding the new
    // scope's cached rows. A still-loaded Main result must not hide Research.
    context.agentSelection.set("research");
    await sidebar.updateComplete;
    harness.publishList(researchSnapshot);
    harness.publishList(mainSnapshot);
    sidebar.sessionKey = "agent:research:one";
    await sidebar.updateComplete;
    const rows = [...sidebar.querySelectorAll(".sidebar-recent-session")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Research task");
  });

  it("routes the agent header to its main session and marks it active there", async () => {
    const { sidebar, setSessionKey, onNavigate } = await mountNavigation();
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:main";
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    const home = sidebar.querySelector<HTMLAnchorElement>('[data-agent-id="main"]');
    expect(home).not.toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-footer-bar__home")).toHaveLength(1);
    expect(home?.getAttribute("aria-current")).toBe("page");

    home?.click();
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main" });
  });

  it("treats the global key as the main session under global scope", async () => {
    const harness = createSessionsHarness("main", ["global"]);
    const globalAgents = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", identity: { name: "Molty" } }],
    } as AgentsListResult;
    const { sidebar } = await mountAgentSidebar(harness.sessions, globalAgents);
    harness.publishList({
      result: sessionList([
        { key: "global", kind: "global", updatedAt: 5, unread: true },
        { key: "agent:main:side-quest", kind: "direct", label: "Side quest", updatedAt: 4 },
      ]),
    });
    sidebar.connected = true;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    // Main navigation and its unread state belong to the agent header, not a duplicate row.
    expect(sidebar.querySelector('[data-session-key="global"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:side-quest"]')).toBeNull();
    expect(
      sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__row'),
    ).not.toBeNull();
  });

  it("keeps main-session activity on its agent header without duplicate main or subagent rows", async () => {
    const key = "main";
    const harness = createSessionsHarness("main", [key]);
    const { sidebar, context } = await mountAgentSidebar(
      harness.sessions,
      agentList([{ id: "main", identity: { name: "Molty" } }]),
    );
    harness.publishList({
      result: sessionList([
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
      ]),
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
    const attention = sidebar.querySelector(
      '[data-agent-group=main] .sidebar-agent-roster__header [data-session-attention="error"]',
    )!;
    expect(attention).not.toBeNull();
    await attention.closest<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip")!
      .updateComplete;
    const description = (attention.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .map((id) => attention.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("Child session Spawned thread failed: Review failed");
  });
});
