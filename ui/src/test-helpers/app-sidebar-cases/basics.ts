import { expect, it, vi } from "vitest";
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
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { agentList, sessionList } from "./compact.test-support.ts";
import { settleRoster } from "./roster.test-support.ts";
import "../../components/app-sidebar.tsx";

await import("../../components/viewer-facepile.ts");

const MAIN = "agent:main:main";
const RESEARCH = "agent:research:main";
const CHILD = "agent:main:subagent:thread-a";

async function mountAgentSidebar(
  sessions = createSessions("main", [MAIN]),
  agents: AgentsListResult | null = TWO_AGENTS,
  gateway = createGateway({} as GatewayBrowserClient),
) {
  const mounted = await mountSidebar(gateway, sessions, "panel", agents);
  return {
    ...mounted,
    find: mounted.sidebar.querySelector.bind(mounted.sidebar),
    findAll: mounted.sidebar.querySelectorAll.bind(mounted.sidebar),
  };
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

it("honors deployment policy and existing Community dismissals", async () => {
  localStorage.setItem("openclaw:control-ui:community-invite:v2", "dismissed");
  const { sidebar, context, find } = await mountAgentSidebar(undefined, null);
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const enabled of [true, false]) {
      fetch.mockResolvedValue(Response.json({ serverVersion: "test", communityInvite: enabled }));
      await context.config.refresh();
      await sidebar.updateComplete;
      expect(find(".community-invite-card")).toBeNull();
    }
    localStorage.removeItem("openclaw:control-ui:community-invite:v2");
    fetch.mockResolvedValue(Response.json({ serverVersion: "test", communityInvite: true }));
    await context.config.refresh();
    await sidebar.updateComplete;
    expect(find(".community-invite-card")).not.toBeNull();
    find<HTMLButtonElement>(".invite__close")!.click();
    await sidebar.updateComplete;
    expect(find(".community-invite-card")).toBeNull();
  } finally {
    fetch.mockRestore();
    localStorage.removeItem("openclaw:control-ui:community-invite:v2");
  }
});

it.each(["chip", "roster"] as const)(
  "opens new-session links directly in %s mode without intercepting browser gestures",
  async (mode) => {
    const { sidebar, find, findAll } = await mountAgentSidebar(
      createSessions("research", [RESEARCH, "agent:research:task"]),
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

    const newSessionLink = find<HTMLAnchorElement>(".sidebar-rail .sidebar-new-session");
    expect(findAll(".sidebar-new-session")).toHaveLength(1);
    expect(find(".sidebar-brand__collapse")).toBeNull();
    find<HTMLButtonElement>('[data-navigation-view="sessions"]')?.click();
    find<HTMLButtonElement>(".sidebar-rail .sidebar-brand__search")?.click();
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
    const link = find<HTMLAnchorElement>(".sidebar-rail .sidebar-new-session")!;
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
        const current = find<HTMLAnchorElement>(".sidebar-rail .sidebar-new-session");
        expect(current).toBe(link);
        expect(findAll(".sidebar-new-session")).toHaveLength(1);
        expect(find(".sidebar-session-toolbar .sidebar-new-session")).toBeNull();
        current!.click();
        expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("research");
        onOpenNewSession.mockClear();
      }
    }
  },
);

it("opens a catalog-targeted draft from its new-session action", async () => {
  const { sidebar, find } = await mountAgentSidebar(createSessions("research", [RESEARCH]), {
    ...agentList([{ id: "main" }, { id: "research" }]),
    mainKey: MAIN,
    scope: "global",
  });
  const onOpenNewSession = vi.fn();
  sidebar.connected = true;
  sidebar.onOpenNewSession = onOpenNewSession;
  sidebar.sessionData.sessionCatalogs = [
    {
      id: "claude",
      label: "Claude Code",
      capabilities: { continueSession: true, archive: false, startTerminal: true },
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

  const link = find<HTMLAnchorElement>(".sidebar-session-catalog-new")!;
  expect(link.getAttribute("aria-label")).toBe("New session — Claude Code");
  expect(link.getAttribute("href")).toBe("/new?agent=research&catalog=claude");
  const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  link.dispatchEvent(contextMenu);
  expect(contextMenu.defaultPrevented).toBe(false);
  expect(find(".sidebar-session-catalog-view-menu")).toBeNull();
  link.click();

  expect(onOpenNewSession).toHaveBeenCalledWith("research", { catalogId: "claude" });
});

it("qualifies unscoped session rows with the selected agent", async () => {
  const { sidebar, find } = await mountAgentSidebar(
    createSessions("research", [RESEARCH, "telegram:12345"]),
    { ...TWO_AGENTS, defaultId: "research" },
  );
  sidebar.sessionKey = RESEARCH;
  await sidebar.updateComplete;

  const href = find<HTMLAnchorElement>(
    '[data-session-key="telegram:12345"] .sidebar-recent-session__link',
  )?.getAttribute("href");
  const sessionUrl = new URL(href ?? "", window.location.origin);
  expect(sessionUrl.pathname).toBe("/chat/research/telegram/12345");
  expect(sessionUrl.search).toBe("");
  expect(sessionRefFromPath(sessionUrl.pathname)).toMatchObject({
    kind: "literal",
    sessionKey: "agent:research:telegram:12345",
  });
});

it.each([true, false])(
  "switches to cached=%s sessions without confusing agent ids with commands",
  async (cached) => {
    const agent = cached ? "main" : "settings";
    const taskKey = "agent:main:dashboard:00000002-0000-4000-8000-000000000000";
    const { sidebar, setSessionKey, onNavigate, find } = await mountNavigation(
      createSessions("main", cached ? [MAIN, taskKey] : [MAIN]),
      cached ? TWO_AGENTS : agentList([{ id: "main" }, { id: agent }]),
    );
    await sidebar.updateComplete;

    await clickAgentMenu(sidebar);
    const entry = find<HTMLElement>(`.sidebar-agent-menu [data-value="agent:${agent}"]`);
    expect(entry).not.toBeNull();
    if (cached) {
      expect(entry?.textContent).toContain("Molty");
    }
    entry!.click();
    await sidebar.updateComplete;
    if (cached) {
      expect(setSessionKey).not.toHaveBeenCalled();
    } else {
      expect(setSessionKey).toHaveBeenCalledWith("agent:settings:main");
    }
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: cached ? "/chat/main/00000002000040008000000000000000" : "/chat/settings",
      search: cached
        ? `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(taskKey)}`
        : `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(onNavigate).not.toHaveBeenCalledWith("appearance");
  },
);

it("switches the Skills owner without opening an agent conversation", async () => {
  const { sidebar, context, find } = await mountAgentSidebar();
  const onNavigate = vi.fn();
  sidebar.activeRouteId = "skills";
  sidebar.connected = true;
  sidebar.onNavigate = onNavigate;
  await sidebar.updateComplete;

  await clickAgentMenu(sidebar);
  await clickAgentMenu(sidebar, "agent:research");

  expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: "research" });
  expect(find(".sidebar-agent-card__name")?.textContent).toContain("research");
  expect(find(".sidebar-agent-menu")).toBeNull();
  expect(onNavigate).not.toHaveBeenCalled();
});

it("keeps the identity card available during recovery and offers retry only offline", async () => {
  const { sidebar, find } = await mountAgentSidebar(undefined, null);
  const onRetryConnect = vi.fn();
  sidebar.onRetryConnect = onRetryConnect;
  sidebar.connected = true;
  await sidebar.updateComplete;

  expect(find(".sidebar-identity-card__subtitle")).toBeNull();
  expect(find(".sidebar-agent-card__main")).toBeNull();
  expect(find(".sidebar-workspace-header__main")?.getAttribute("aria-label")).not.toContain(
    "Online",
  );

  sidebar.connected = false;
  sidebar.connectionStatus = "reconnecting";
  await sidebar.updateComplete;
  const card = find<HTMLButtonElement>(".sidebar-identity-card");
  expect(card?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe("Owner");
  expect(card?.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
  expect(find(".gateway-status")).toBeNull();
  expect(card?.getAttribute("data-connection-status")).toBe("reconnecting");
  expect(card?.querySelector(".sidebar-identity-card__status")).not.toBeNull();
  expect(card?.getAttribute("aria-label")).toBe("Identity and app menu for Owner: Reconnecting…");
  expect(find(".sidebar-agent-card__subtitle-row")).toBeNull();

  card?.click();
  await sidebar.updateComplete;
  const menu = find<HTMLElement>(".sidebar-identity-menu");
  expect(menu).not.toBeNull();
  expect(menu?.querySelector('[data-value="command:retry-connect"]')).toBeNull();
  expect(onRetryConnect).not.toHaveBeenCalled();

  sidebar.connectionStatus = "offline";
  await sidebar.updateComplete;
  expect(find(".sidebar-identity-card")).toBe(card);
  expect(card?.getAttribute("data-connection-status")).toBe("offline");
  const retry = menu?.querySelector<HTMLElement>('[data-value="command:retry-connect"]');
  expect(retry).not.toBeNull();
  retry?.click();
  await vi.waitFor(() => expect(onRetryConnect).toHaveBeenCalledOnce());

  sidebar.connectionStatus = null;
  await sidebar.updateComplete;
  expect(find(".sidebar-identity-card__subtitle")).toBeNull();
  expect(find(".gateway-status")).toBeNull();
  expect(card?.getAttribute("data-connection-status")).toBeNull();
});

it("keeps the sessions list flat for the selected agent and flags other-agent unread", async () => {
  const harness = createSessionsHarness("main", [MAIN]);
  const { sidebar, context, find, findAll } = await mountAgentSidebar(harness.sessions);
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
    result: sessionList([{ key: MAIN, kind: "direct", label: "Main task", updatedAt: 5 }], 3),
    agentId: "main",
  } satisfies Parameters<typeof harness.publishList>[0];
  harness.publishList(researchSnapshot);
  harness.publishList(mainSnapshot);
  await sidebar.updateComplete;

  expect(find(".sidebar-agent-card__subtitle-row")).toBeNull();
  expect(find(".sidebar-agent-section")).toBeNull();
  expect(findAll(".sidebar-recent-session")).toHaveLength(0);
  expect(find(".sidebar-agent-card__avatar .sidebar-agent-card__menu-unread")).not.toBeNull();

  // Retire Main before admitting cached Research, then deliver a stale Main result.
  context.agentSelection.set("research");
  await sidebar.updateComplete;
  harness.publishList(researchSnapshot);
  harness.publishList(mainSnapshot);
  sidebar.sessionKey = "agent:research:one";
  await sidebar.updateComplete;
  const rows = [...findAll(".sidebar-recent-session")];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("Research task");
});

it("routes the agent header to its main session and marks it active there", async () => {
  const { sidebar, setSessionKey, onNavigate, find, findAll } = await mountNavigation();
  (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
  sidebar.sessionKey = MAIN;
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);

  const home = find<HTMLAnchorElement>('[data-agent-id="main"]');
  expect(home).not.toBeNull();
  expect(findAll(".sidebar-footer-bar__home")).toHaveLength(1);
  expect(home?.getAttribute("aria-current")).toBe("page");

  home?.click();
  expect(setSessionKey).toHaveBeenCalledWith(MAIN);
  expect(onNavigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main" });
});

it("treats the global key as the main session under global scope", async () => {
  const harness = createSessionsHarness("main", ["global"]);
  const globalAgents = {
    ...agentList([{ id: "main", identity: { name: "Molty" } }]),
    scope: "global" as const,
  };
  const { sidebar, find } = await mountAgentSidebar(harness.sessions, globalAgents);
  harness.publishList({
    result: sessionList([
      { key: "global", kind: "global", updatedAt: 5, unread: true },
      { key: "agent:main:side-quest", kind: "direct", label: "Side quest", updatedAt: 4 },
    ]),
  });
  sidebar.connected = true;
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);

  expect(find('[data-session-key="global"]')).toBeNull();
  expect(find('[data-session-key="agent:main:side-quest"]')).toBeNull();
  expect(find('[data-agent-group="main"] .sidebar-agent-roster__row')).not.toBeNull();
});

it("keeps main-session activity on its agent header without duplicate main or subagent rows", async () => {
  const key = "main";
  const harness = createSessionsHarness("main", [key]);
  const { sidebar, context, find, findAll } = await mountAgentSidebar(
    harness.sessions,
    agentList([{ id: "main", identity: { name: "Molty" } }]),
  );
  const header = "[data-agent-group=main] .sidebar-agent-roster__header";
  harness.publishList({
    result: sessionList([
      {
        key,
        kind: "direct",
        label: "[OpenClaw heartbeat poll]",
        category: "Team",
        updatedAt: 5,
        childSessions: [CHILD],
      },
      {
        key: CHILD,
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

  expect(findAll('[data-agent-id="main"][href="/chat/main"]')).toHaveLength(1);
  expect(find(`[data-session-key="${key}"]`)).toBeNull();
  expect(find(`[data-child-session-toggle="${key}"]`)).toBeNull();
  expect(find("[data-session-key=CHILD]")).toBeNull();
  expect(find(`${header} .session-glyph__ring[aria-label="Active run"]`)).not.toBeNull();

  const result = harness.sessions.state.result!;
  const [parent, child] = result.sessions;
  harness.publishList({
    result: {
      ...result,
      ts: 3,
      sessions: [
        parent!,
        {
          ...child!,
          hasActiveRun: false,
          status: "failed",
          endedAt: 6,
          updatedAt: 6,
          lastRunError: "Review failed",
        },
      ],
    },
  });
  await rosterActivityStore(context).refresh();
  await settleRoster(sidebar);
  expect(findAll(header)).toHaveLength(1);
  expect(find(`[data-session-key="${key}"]`)).toBeNull();
  expect(find(`${header} .session-glyph__ring`)).toBeNull();
  const attention = find(`${header} [data-session-attention="error"]`)!;
  expect(attention).not.toBeNull();
  await attention.closest<HTMLElementTagNameMap["openclaw-tooltip"]>("openclaw-tooltip")!
    .updateComplete;
  const description = (attention.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .map((id) => attention.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
  expect(description).toContain("Child session Spawned thread failed: Review failed");
});
