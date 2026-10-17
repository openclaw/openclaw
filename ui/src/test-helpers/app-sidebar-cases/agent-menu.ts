import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_FACE_PREFERENCE_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  manyAgents,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.tsx";
import { domProbe } from "../dom-probe.ts";
import { agentList } from "./compact.test-support.ts";
import { settleRoster } from "./roster.test-support.ts";

async function mountAgent(
  gateway = createGateway({} as GatewayBrowserClient),
  agents: Parameters<typeof mountSidebar>[3] = TWO_AGENTS,
  identity?: Parameters<typeof mountSidebar>[5],
) {
  const mounted = await mountSidebar(
    gateway,
    createSessions("main", ["agent:main:main"]),
    "panel",
    agents,
    [],
    identity,
  );
  return { ...mounted, dom: domProbe(mounted.sidebar) };
}

async function openAgentMenu(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"]) {
  sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
  await sidebar.updateComplete;
}

describe("AppSidebar agent chip", () => {
  it("keeps a configured avatar blank while waiting for authentication", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ hello: null });
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    const { dom } = await mountAgent(gateway.gateway, {
      ...TWO_AGENTS,
      agents: [{ id: "main", identity: { avatarUrl: "/avatar/main", emoji: "🦞" } }],
    });
    const avatar = dom.query(".sidebar-agent-card__avatar .identity-avatar--agent");
    expect(avatar?.classList).toContain("is-pending");
    expect(avatar?.classList).not.toContain("is-fallback");
    expect(avatar?.querySelector("img")).toBeNull();
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("loads the workspace identity used by the Agents editor", async () => {
    const request = vi.fn().mockResolvedValue({
      agentId: "main",
      name: "Workspace Molty",
      emoji: "🦞",
      avatar: "data:image/png;base64,d29ya3NwYWNl",
    });
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar, dom } = await mountAgent(
      gatewayHarness.gateway,
      agentList([{ id: "main" }]),
      agentIdentity,
    );

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(dom.text(".sidebar-agent-card__name")?.trim()).toContain("Workspace Molty");
      expect(dom.query<HTMLImageElement>(".sidebar-agent-card__avatar img")?.src).toBe(
        "data:image/png;base64,d29ya3NwYWNl",
      );
    });
    expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" });
    await settleRoster(sidebar);
    request.mockResolvedValue({
      agentId: "main",
      name: "Updated workspace",
      emoji: "⚓",
      avatar: "data:image/png;base64,dXBkYXRlZA==",
    });
    gatewayHarness.publishEvent("agent.identity.changed", { agentId: "main" });
    await agentIdentity.ensure(["main"]);
    await settleRoster(sidebar);
    expect(dom.text(".sidebar-agent-card__name")).toContain("Updated workspace");
    expect(dom.query<HTMLImageElement>(".sidebar-agent-card__avatar img")?.src).toBe(
      "data:image/png;base64,dXBkYXRlZA==",
    );
  });

  it.each(["loading", "excluded"] as const)(
    "does not revive a hydrated picker identity when discovery is %s",
    async (discovery) => {
      const request = vi.fn(async (_method: string, params: { agentId: string }) => ({
        agentId: params.agentId,
        name: params.agentId === "main" ? "Private agent" : "Shared agent",
        emoji: "🦞",
      }));
      const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
      await agentIdentity.ensure(["main"]);
      const sessions = createSessions("main", ["agent:main:thread:readable"]);
      const row = sessions.state.result?.sessions[0];
      if (row) {
        row.displayName = "Existing readable conversation";
      }
      const { sidebar } = await mountSidebar(
        gatewayHarness.gateway,
        sessions,
        "panel",
        discovery === "loading" ? null : { ...TWO_AGENTS, agents: [{ id: "shared" }] },
        [],
        agentIdentity,
      );
      const dom = domProbe(sidebar);

      sidebar.connected = true;
      await sidebar.updateComplete;
      expect(dom.text(".sidebar-agent-card__name")).not.toContain("Private agent");
      if (discovery === "loading") {
        expect(dom.query(".sidebar-agent-card__main")).toBeNull();
        expect(dom.text(".sidebar-recent-session__title-row")).toContain(
          "Existing readable conversation",
        );
      } else {
        expect(dom.attr(".sidebar-agent-card__main", "aria-label")).toMatch(/shared/i);
      }
      dom
        .query<HTMLButtonElement>(".sidebar-workspace-header__main, .sidebar-agent-card__main")
        ?.click();
      await vi.dynamicImportSettled();
      await sidebar.updateComplete;
      expect(dom.text(".sidebar-agent-menu")).not.toContain("Private agent");
      const capabilities = dom.query('[data-value="command:capabilities"]');
      if (discovery === "loading") {
        expect(capabilities).toBeNull();
      } else {
        expect(capabilities?.textContent).toMatch(/shared/i);
      }
      expect(dom.query('[data-value="command:agent-settings"]')?.hasAttribute("disabled")).toBe(
        discovery === "loading",
      );
    },
  );

  it("keeps the configured roster label when identity hydration returns a fallback", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) =>
      params.agentId === "main"
        ? { agentId: "main", name: "Workspace Molty", avatar: "🦞" }
        : { agentId: "rust-claw", name: "Assistant", avatar: "🦀" },
    );
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar, dom } = await mountAgent(
      gatewayHarness.gateway,
      agentList([{ id: "main" }, { id: "rust-claw", name: "rust-claw" }]),
      agentIdentity,
    );

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("Workspace Molty");
    });
    dom.query<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "rust-claw" });
      const labels = [...dom.all(".sidebar-agent-menu .agent-select__option-label")].map(
        (element) => element.textContent?.trim(),
      );
      expect(labels).toEqual(["Show all", "Workspace Molty", "rust-claw"]);
    });
    await vi.waitFor(() => {
      const rustRow = [...dom.all<HTMLElement>(".sidebar-agent-menu__agent-switch")].find((row) =>
        row.textContent?.includes("rust-claw"),
      );
      expect(rustRow?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
        "🦀",
      );
    });
  });

  it("hydrates agents added while the switcher remains open", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) => ({
      agentId: params.agentId,
      name: `Workspace ${params.agentId}`,
    }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar, context, dom } = await mountAgent(
      gatewayHarness.gateway,
      agentList([{ id: "main" }]),
      agentIdentity,
    );
    sidebar.connected = true;
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" }),
    );
    await openAgentMenu(sidebar);
    expect(dom.query(".sidebar-agent-menu")).not.toBeNull();

    (context.agents.state as { agentsList: AgentsListResult | null }).agentsList = TWO_AGENTS;
    sidebar.invalidate();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "research" });
      expect(dom.text(".sidebar-agent-menu")).toContain("Workspace research");
    });
  });

  it("opens the agent-scoped menu with its inline roster", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar, context, dom } = await mountAgent(gatewayHarness.gateway, {
      ...TWO_AGENTS,
      agents: [
        { id: "main", identity: { name: "Molty", emoji: "🦞" } },
        {
          id: "research",
          identity: { avatarUrl: "data:image/png;base64,eA==" },
        },
      ],
    });
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("Molty");
    await openAgentMenu(sidebar);

    const menu = dom.query(".sidebar-agent-menu");
    expect(menu).not.toBeNull();
    const menuDom = domProbe(menu!);
    expect(
      menuDom.present(
        ".sidebar-pair-mobile",
        "openclaw-sidebar-build-chip",
        "openclaw-theme-mode-toggle",
        "[aria-checked], .session-menu__check",
        '[data-value="scope:all"]',
      ),
    ).toEqual([false, false, false, false, true]);
    expect(menuDom.all('[role="separator"]')).toHaveLength(2);
    expect(
      menu
        ?.querySelector('[role="separator"]')
        ?.previousElementSibling?.classList.contains("sidebar-agent-menu__agent-list"),
    ).toBe(true);
    expect(
      [...menuDom.all('[role^="menuitem"]')].map((element) => element.getAttribute("data-value")),
    ).toEqual([
      "scope:all",
      "agent:main",
      "agent:research",
      "command:new-agent",
      "command:agents-directory",
      "command:capabilities",
      "command:agent-settings",
    ]);

    const commands = [...menuDom.all('[data-value^="command:"]')];
    expect(commands.map((item) => item.textContent?.trim())).toEqual([
      "New agent",
      "See all agents",
      "What can Molty do?",
      "Molty settings",
    ]);
    for (const command of commands) {
      expect(command.querySelector(".oc-menu-item__icon svg")).not.toBeNull();
    }

    const agentRows = [...menuDom.all('[data-value^="agent:"]')];
    expect(agentRows).toHaveLength(2);
    expect(agentRows[0]?.classList.contains("sidebar-agent-menu__agent-switch--active")).toBe(true);
    expect(agentRows[0]?.querySelector(".sidebar-agent-menu__agent-row")).not.toBeNull();
    expect(menuDom.attr(".identity-avatar__text", "data-avatar")).toBe("🦞");
    expect(menuDom.query<HTMLImageElement>(".agent-select__avatar img")?.src).toContain(
      "data:image/png;base64,eA==",
    );
    const researchRow = [...menuDom.all<HTMLElement>(".sidebar-agent-menu__agent-switch")].find(
      (row) => row.textContent?.includes("research"),
    );
    expect(researchRow).toBeDefined();
    researchRow?.click();
    await sidebar.updateComplete;

    expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: "research" });
    expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("research");
    // No cached sessions for the other agent: resume falls back to its main key, and
    // the uncached face is a guess, so navigation is marked for gateway re-derivation.
    expect(setSessionKey).toHaveBeenCalledWith("agent:research:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(dom.query(".sidebar-agent-menu")).toBeNull();
  });

  it.each(["chip", "roster"] as const)(
    "requests composer focus from the active agent's capabilities in %s mode",
    async (mode) => {
      const { sidebar, context, dom } = await mountAgent();
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      sidebar.activeRouteId = "skills";
      context.agentSelection.set("research");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;

      dom
        .query<HTMLButtonElement>(".sidebar-agent-card__main, .sidebar-workspace-header__main")
        ?.click();
      await sidebar.updateComplete;
      const item = dom.query<HTMLElement>('[data-value="command:capabilities"]');
      expect(item?.textContent).toContain("What can research do?");
      item?.click();
      await sidebar.updateComplete;

      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());
      const options = onNavigate.mock.calls[0]?.[1] as { pathname: string; search: string };
      expect(options.pathname).toBe("/chat/research");
      const search = new URLSearchParams(options.search);
      expect(search.get("draft")).toBe("What can you do?");
      expect(search.get(SESSION_COMPOSER_FOCUS_PARAM)).toBe("1");
    },
  );

  it("drops the menu below the agent card instead of covering it", async () => {
    const { sidebar, dom } = await mountAgent();
    sidebar.connected = true;
    await sidebar.updateComplete;

    const card = dom.query<HTMLButtonElement>(".sidebar-agent-card__main");
    if (!card) {
      throw new Error("Expected the sidebar agent card");
    }
    card.getBoundingClientRect = () => ({ bottom: 88, left: 12, right: 252, top: 40 }) as DOMRect;
    card.click();
    await sidebar.updateComplete;

    const menus = (sidebar as unknown as { sidebarMenus: { agentMenuPosition: unknown } })
      .sidebarMenus;
    expect(menus.agentMenuPosition).toEqual({ x: 12, top: 92 });
    const menu = dom.query(".sidebar-agent-menu");
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.previousElementSibling?.getAttribute("style")).toContain("top: 92px");
  });

  it("keeps the widened agent menu inside a narrow viewport", async () => {
    vi.stubGlobal("innerWidth", 280);
    const { sidebar, dom } = await mountAgent();
    sidebar.connected = true;
    await sidebar.updateComplete;

    const card = dom.query<HTMLButtonElement>(".sidebar-agent-card__main");
    if (!card) {
      throw new Error("Expected the sidebar agent card");
    }
    card.getBoundingClientRect = () => ({ bottom: 88, left: 100, right: 340, top: 40 }) as DOMRect;
    card.click();
    await sidebar.updateComplete;

    const menus = (sidebar as unknown as { sidebarMenus: { agentMenuPosition: unknown } })
      .sidebarMenus;
    expect(menus.agentMenuPosition).toEqual({ x: 8, top: 92 });
  });

  it("opens the agent menu on right-click without toggling an open menu", async () => {
    const { sidebar, dom } = await mountAgent();
    const card = dom.query<HTMLElement>("openclaw-sidebar-agent-card");
    const trigger = card?.querySelector<HTMLElement>(".sidebar-agent-card__main");
    const label = card?.querySelector<HTMLElement>(".sidebar-agent-card__name");
    if (!card || !trigger || !label) {
      throw new Error("Expected the sidebar agent card");
    }
    trigger.getBoundingClientRect = () =>
      ({ bottom: 88, left: 12, right: 252, top: 40 }) as DOMRect;

    const firstContextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    label.dispatchEvent(firstContextMenu);
    await sidebar.updateComplete;
    const firstMenu = dom.query(".sidebar-agent-menu");
    expect(firstContextMenu.defaultPrevented).toBe(true);
    expect(firstMenu).not.toBeNull();

    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    expect(dom.query(".sidebar-agent-menu")).toBe(firstMenu);
  });

  it.each([
    { count: 6, pins: [], order: [1, 2, 3, 4, 5, 6] },
    { count: 12, pins: ["agent-7", "agent-12"], order: [7, 12, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11] },
    { count: 12, pins: [], order: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { count: 12, pins: ["deleted-agent"], order: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  ])(
    "keeps all $count agents in pin order without a search field (pins=$pins)",
    async ({ count, pins, order }) => {
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("agent-1", ["agent:agent-1:main"]),
        "panel",
        manyAgents(count),
      );
      const dom = domProbe(sidebar);
      sidebar.connected = true;
      sidebar.pinnedAgentIds = pins;
      context.agentSelection.set("agent-1");
      await sidebar.updateComplete;
      await openAgentMenu(sidebar);
      expect(dom.query(".sidebar-agent-menu__filter")).toBeNull();
      expect(dom.query(".sidebar-agent-menu__agent-list")).not.toBeNull();
      expect(
        [...dom.all('.sidebar-agent-menu [data-value^="agent:"] .agent-select__option-label')].map(
          (item) => item.textContent?.trim(),
        ),
      ).toEqual(order.map((id) => "agent-" + id));
    },
  );

  it("loads switcher avatar tiles through the authenticated avatar loader", async () => {
    const avatarRoute = "/avatar/research?v=140879";
    const createObjectURL = vi.fn(() => "blob:agent-avatar");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const response = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    setAvatarGatewayOrigin(globalThis.location.origin, ["secret-token"]);
    try {
      const { sidebar, dom } = await mountAgent(createGateway({} as GatewayBrowserClient), {
        ...TWO_AGENTS,
        agents: [
          { id: "main", identity: { name: "Molty", emoji: "🦞" } },
          { id: "research", identity: { avatarUrl: avatarRoute } },
        ],
      });
      sidebar.connected = true;
      await sidebar.updateComplete;

      await openAgentMenu(sidebar);
      const menu = dom.query(".sidebar-agent-menu");
      expect(menu).not.toBeNull();
      const researchRow = [
        ...(menu?.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch") ?? []),
      ].find((row) => row.textContent?.includes("research"));
      expect(researchRow).toBeDefined();
      let avatar = researchRow?.querySelector(".agent-select__avatar");
      expect(avatar?.classList).toContain("is-pending");
      expect(avatar?.classList).not.toContain("is-fallback");

      response.resolve(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      await vi.waitFor(() => {
        expect(
          researchRow
            ?.querySelector<HTMLImageElement>(".agent-select__avatar img")
            ?.getAttribute("src"),
        ).toBe("blob:agent-avatar");
      });
      avatar = researchRow?.querySelector(".agent-select__avatar");
      expect(avatar?.classList).toContain("is-pending");
      avatar?.querySelector("img")?.dispatchEvent(new Event("load"));
      expect(avatar?.classList).not.toContain("is-pending");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${globalThis.location.origin}/avatar/research?v=140879`,
        expect.objectContaining({
          headers: { Authorization: "Bearer secret-token" },
        }),
      );
    } finally {
      response.resolve(new Response(null, { status: 404 }));
      setAvatarGatewayOrigin(null);
      vi.unstubAllGlobals();
    }
  });
});
