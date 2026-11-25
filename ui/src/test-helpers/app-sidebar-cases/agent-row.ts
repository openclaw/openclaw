import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { patchSettings } from "../../app/settings.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";
import { domProbe } from "../dom-probe.ts";
import { agentList, sessionList } from "./compact.test-support.ts";
import { mountRoster, session, settleRoster } from "./roster.test-support.ts";

const selectedRow = ".sidebar-agent-roster--selected .sidebar-agent-roster__header";
const avatarImage = `${selectedRow} .sidebar-agent-roster__avatar img`;
const rowName = `${selectedRow} .sidebar-agent-roster__name`;

async function mountAgent(
  gateway = createGateway({} as GatewayBrowserClient),
  agents: Parameters<typeof mountSidebar>[3] = TWO_AGENTS,
  identity?: Parameters<typeof mountSidebar>[5],
  sessions = createSessions("main", ["agent:main:main"]),
) {
  const mounted = await mountSidebar(gateway, sessions, "panel", agents, [], identity);
  return { ...mounted, dom: domProbe(mounted.sidebar) };
}

async function mountIdentity(client: GatewayBrowserClient, agents = agentList([{ id: "main" }])) {
  const gateway = createGatewayHarness(client);
  const identity = createAgentIdentityCapability(gateway.gateway);
  return { ...(await mountAgent(gateway.gateway, agents, identity)), gateway, identity };
}

/** Opens the row's kebab once its lazily loaded menu has mounted. */
async function openRowMenu(
  sidebar: HTMLElement & { updateComplete: Promise<unknown> },
  header: string,
) {
  await vi.dynamicImportSettled();
  await vi.waitFor(() =>
    expect(sidebar.querySelector(`${header} .sidebar-agent-roster__action`)).not.toBeNull(),
  );
  sidebar.querySelector<HTMLButtonElement>(`${header} .sidebar-agent-roster__action`)!.click();
  await sidebar.updateComplete;
  await vi.waitFor(() =>
    expect(sidebar.querySelector(`${header} [role="menu"] [data-value]`)).not.toBeNull(),
  );
  return domProbe(sidebar.querySelector<HTMLElement>(`${header} [role="menu"]`)!);
}

describe("AppSidebar selected agent row", () => {
  it("keeps a configured avatar blank while waiting for authentication", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ hello: null });
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    const { dom } = await mountAgent(gateway.gateway, {
      ...TWO_AGENTS,
      agents: [{ id: "main", identity: { avatarUrl: "/avatar/main", emoji: "🦞" } }],
    });
    const avatar = dom.query(`${selectedRow} .identity-avatar--agent`);
    expect(avatar?.classList).toContain("is-pending");
    expect(avatar?.classList).not.toContain("is-fallback");
    expect(avatar?.querySelector("img")).toBeNull();
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("loads the workspace identity used by the Agents editor", async () => {
    const firstAvatar = "data:image/png;base64,d29ya3NwYWNl";
    const nextAvatar = "data:image/png;base64,dXBkYXRlZA==";
    const first = { agentId: "main", name: "Workspace Molty", emoji: "🦞", avatar: firstAvatar };
    const next = { agentId: "main", name: "Updated workspace", emoji: "⚓", avatar: nextAvatar };
    const request = vi.fn().mockResolvedValue(first);
    const { sidebar, dom, gateway, identity } = await mountIdentity({
      request,
    } as unknown as GatewayBrowserClient);

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(dom.text(rowName)?.trim()).toBe("Workspace Molty");
      expect(dom.query<HTMLImageElement>(avatarImage)?.src).toBe(firstAvatar);
    });
    expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" });
    await settleRoster(sidebar);
    request.mockResolvedValue(next);
    gateway.publishEvent("agent.identity.changed", { agentId: "main" });
    await identity.ensure(["main"]);
    await settleRoster(sidebar);
    expect(dom.text(rowName)).toContain("Updated workspace");
    expect(dom.query<HTMLImageElement>(avatarImage)?.src).toBe(nextAvatar);
  });

  it.each(["loading", "excluded"] as const)("hides private agents (%s)", async (discovery) => {
    const request = vi.fn(async (_method: string, { agentId }: { agentId: string }) => ({
      agentId,
      name: agentId === "main" ? "Private agent" : "Shared agent",
      emoji: "🦞",
    }));
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const identity = createAgentIdentityCapability(gateway.gateway);
    await identity.ensure(["main"]);
    const sessions = createSessions("main", ["agent:main:thread:readable"]);
    sessions.state.result!.sessions[0]!.displayName = "Existing readable conversation";
    const agents = discovery === "loading" ? null : agentList([{ id: "shared" }]);
    const { sidebar, dom } = await mountAgent(gateway.gateway, agents, identity, sessions);

    sidebar.connected = true;
    await sidebar.updateComplete;
    expect(dom.text(selectedRow) ?? "").not.toContain("Private agent");
    if (discovery === "loading") {
      expect(dom.query(selectedRow)).toBeNull();
      expect(dom.text(".sidebar-recent-session__title-row")).toContain(
        "Existing readable conversation",
      );
    } else {
      expect(dom.text(rowName)?.trim()).toBe("shared");
    }
  });

  it("keeps the configured roster label when identity hydration returns a fallback", async () => {
    const request = vi.fn(async (_method: string, { agentId }: { agentId: string }) =>
      agentId === "main"
        ? { agentId: "main", name: "Workspace Molty", avatar: "🦞" }
        : { agentId: "rust-claw", name: "Assistant", avatar: "🦀" },
    );
    const { sidebar, dom } = await mountIdentity(
      { request } as unknown as GatewayBrowserClient,
      agentList([{ id: "main" }, { id: "rust-claw", name: "rust-claw" }]),
    );

    sidebar.connected = true;
    await vi.waitFor(() => expect(dom.text(rowName)?.trim()).toBe("Workspace Molty"));
    // Only the selected agent's identity is requested; the roster loads its own.
    expect(request).not.toHaveBeenCalledWith("agent.identity.get", { agentId: "rust-claw" });
  });

  it("leads the list with the main conversation and the agent's latest reply", async () => {
    const sessions = createSessions("main", ["agent:main:main", "agent:main:dashboard:notes"]);
    const [main, notes] = sessions.state.result!.sessions;
    main!.lastAssistantMessage = { text: "Morning summary sent.", timestamp: 5 };
    // Like the roster row, the subtitle follows the agent's newest reply in any conversation.
    notes!.lastAssistantMessage = { text: "The outline is ready.", timestamp: 10 };
    const { sidebar, dom } = await mountAgent(undefined, TWO_AGENTS, undefined, sessions);
    const onNavigate = vi.fn();
    Object.assign(sidebar, { connected: true, onNavigate });
    await sidebar.updateComplete;

    expect(dom.text(rowName)?.trim()).toBe("Molty");
    expect(dom.text(`${selectedRow} .sidebar-agent-roster__preview`)).toBe("The outline is ready.");
    // The main conversation is the row, never a duplicate session entry.
    expect(dom.query('.sidebar-recent-session[data-session-key="agent:main:main"]')).toBeNull();
    dom.query<HTMLAnchorElement>(`${selectedRow} .sidebar-agent-roster__row`)!.click();
    expect(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/main" }),
    );
  });

  it("puts the agent row above the Sessions header, beside the collapse button", async () => {
    const { sidebar, dom } = await mountAgent();
    sidebar.connected = true;
    await sidebar.updateComplete;

    const lead = dom.query(".sidebar-agent-lead")!;
    const toolbar = dom.query(".sidebar-session-toolbar")!;
    expect(lead.querySelector(".sidebar-agent-roster--selected")).not.toBeNull();
    expect(lead.querySelector(".sidebar-session-toolbar__collapse")).not.toBeNull();
    expect(lead.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.querySelector(".sidebar-session-toolbar__collapse")).toBeNull();

    patchSettings({ sidebarAgentsMode: "roster" });
    await settleRoster(sidebar);
    expect(dom.query(".sidebar-agent-lead")).toBeNull();
    expect(dom.query(".sidebar-session-toolbar .sidebar-session-toolbar__collapse")).not.toBeNull();
  });

  it("offers Show all agents and New agent before the agent's own actions", async () => {
    const { sidebar, context, dom } = await mountAgent();
    const onNavigate = vi.fn();
    Object.assign(sidebar, { connected: true, onNavigate });
    await sidebar.updateComplete;

    const menu = await openRowMenu(sidebar, selectedRow);
    expect(
      [...menu.all('[role^="menuitem"]')].map((item) => item.getAttribute("data-value")),
    ).toEqual(["show-all", "new-agent", "pin", "sessions", "settings", "delete"]);
    expect(menu.all('[role="separator"]')).toHaveLength(1);
    menu.query<HTMLElement>('[data-value="show-all"]')!.click();
    await settleRoster(sidebar);

    expect(sidebar.sidebarAgentsMode).toBe("roster");
    expect(context.agentSelection.state).toEqual({ selectedId: "main", scopeId: null });
    // Show all changes the list, not the page.
    expect(onNavigate).not.toHaveBeenCalled();
    expect(dom.query(".sidebar-agent-roster--selected")).toBeNull();
  });

  it("opens agent creation from the row menu", async () => {
    const { sidebar } = await mountAgent();
    sidebar.connected = true;
    await sidebar.updateComplete;

    const menu = await openRowMenu(sidebar, selectedRow);
    // Creation is offered once its dialog renderer has loaded.
    await vi.waitFor(() =>
      expect(menu.query('[data-value="new-agent"]')?.getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    menu.query<HTMLElement>('[data-value="new-agent"]')!.click();
    await sidebar.updateComplete;
    expect(sidebar.sidebarMenus.agentCreateDialogOpen).toBe(true);
  });

  it("keeps the menu in view while other agents have unread conversations", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
      "panel",
      TWO_AGENTS,
    );
    sidebar.connected = true;
    harness.publishList({
      result: sessionList([
        {
          key: "agent:research:one",
          kind: "direct",
          label: "Research",
          updatedAt: 3,
          unread: true,
        },
      ]),
      agentId: "research",
    });
    harness.publishList({
      result: sessionList([{ key: "agent:main:main", kind: "direct", updatedAt: 5 }], 3),
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(selectedRow)?.classList).toContain(
      "sidebar-agent-roster__header--attention",
    );
    const menu = await openRowMenu(sidebar, selectedRow);
    expect(menu.query('[data-value="show-all"] .session-unread-dot')).not.toBeNull();
  });
});

describe("AppSidebar roster row menu", () => {
  it("rings the selected row while its main conversation works", async () => {
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar, dom } = await mountAgent(undefined, TWO_AGENTS, undefined, harness.sessions);
    const ring = `${selectedRow} .session-glyph__ring[aria-label="Active run"]`;
    const main = (extra: Partial<GatewaySessionRow>) => ({
      key: "agent:main:main",
      kind: "direct" as const,
      ...extra,
    });
    sidebar.connected = true;
    harness.publishList({
      result: sessionList([main({ updatedAt: 5, hasActiveRun: true, status: "running" })]),
    });
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(dom.query(ring)).not.toBeNull());

    harness.publishList({
      result: sessionList([main({ updatedAt: 6, hasActiveRun: false, status: "done" })]),
    });
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(dom.query(ring)).toBeNull());
  });

  it("marks the agent in use with the Gateway environment in both list modes", async () => {
    const bootstrap = { basePath: "", assistantName: "OpenClaw", assistantAvatar: "O" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ ...bootstrap, environment: { label: "edge", color: "amber" } }),
        ),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { sidebar, context } = await mountRoster(undefined, [
      session("main", 10),
      session("working", 11),
    ]);
    await context.config.refresh();
    await settleRoster(sidebar);
    const dom = domProbe(sidebar);
    await vi.waitFor(() =>
      expect(dom.text(`${selectedRow} .control-ui-environment-pill`)).toBe("edge"),
    );
    expect(dom.query(`${selectedRow} .sidebar-agent-roster__avatar--environment`)).not.toBeNull();

    patchSettings({ sidebarAgentsMode: "roster" });
    await settleRoster(sidebar);
    await vi.waitFor(() =>
      expect(
        dom.query('[data-agent-group="working"] .sidebar-agent-roster__header'),
      ).not.toBeNull(),
    );
    expect(
      [...dom.all(".sidebar-agent-roster__header .control-ui-environment-pill")].map((pill) =>
        pill.closest("[data-agent-group]")?.getAttribute("data-agent-group"),
      ),
    ).toEqual(["main"]);
  });

  it("narrows the list to one agent and opens its main conversation", async () => {
    const { sidebar, context } = await mountRoster(undefined, [
      session("main", 10),
      session("working", 11, { lastAssistantMessage: { text: "Build is green.", timestamp: 11 } }),
    ]);
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    patchSettings({ sidebarAgentsMode: "roster" });
    await settleRoster(sidebar);
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-agent-group="working"]')).not.toBeNull(),
    );

    const header = '[data-agent-group="working"] .sidebar-agent-roster__header';
    const menu = await openRowMenu(sidebar, header);
    expect(
      [...menu.all('[role^="menuitem"]')].map((item) => item.getAttribute("data-value")),
    ).toEqual(["show-only", "new-agent", "pin", "sessions", "settings", "delete"]);
    menu.query<HTMLElement>('[data-value="show-only"]')!.click();
    await settleRoster(sidebar);

    expect(sidebar.sidebarAgentsMode).toBe("chip");
    expect(context.agentSelection.state.selectedId).toBe("working");
    expect(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working" }),
    );
  });

  it("keeps the open conversation when it already belongs to that agent", async () => {
    const { sidebar } = await mountRoster(undefined, [
      session("main", 10),
      session("working", 11, { key: "agent:working:dashboard:build", isMain: false }),
    ]);
    const onNavigate = vi.fn();
    Object.assign(sidebar, {
      onNavigate,
      activeRouteId: "chat",
      getRouteSessionKey: () => "agent:working:dashboard:build",
    });
    patchSettings({ sidebarAgentsMode: "roster" });
    await settleRoster(sidebar);
    await vi.waitFor(() =>
      expect(sidebar.querySelector('[data-agent-group="working"]')).not.toBeNull(),
    );

    const menu = await openRowMenu(
      sidebar,
      '[data-agent-group="working"] .sidebar-agent-roster__header',
    );
    menu.query<HTMLElement>('[data-value="show-only"]')!.click();
    await settleRoster(sidebar);

    expect(sidebar.sidebarAgentsMode).toBe("chip");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("AppSidebar rail Home", () => {
  it("leads the rail and fills only while the Home dock is open", async () => {
    const { sidebar, context, dom } = await mountAgent();
    sidebar.connected = true;
    await sidebar.updateComplete;

    const rail = dom.query(".sidebar-rail")!;
    expect(rail.firstElementChild?.querySelector(".sidebar-rail__home")).not.toBeNull();
    expect(dom.query(".sidebar-rail__bottom .sidebar-rail__home")).toBeNull();
    const home = dom.query<HTMLButtonElement>(".sidebar-rail__home")!;
    expect(home.getAttribute("aria-pressed")).toBe("false");
    expect(home.querySelector('svg path[fill="currentColor"]')).toBeNull();

    const owner = {
      openSession: vi.fn(),
      closeSession: vi.fn(),
      openSessionKey: null,
      homeOpen: true,
    };
    const detach = context.assistantDock.attach(owner);
    await vi.waitFor(() => expect(home.getAttribute("aria-pressed")).toBe("true"));
    expect(home.querySelector('svg path[fill="currentColor"]')).not.toBeNull();
    detach();
    await vi.waitFor(() => expect(home.getAttribute("aria-pressed")).toBe("false"));
  });
});
