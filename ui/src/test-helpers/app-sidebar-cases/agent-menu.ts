import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
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
import { waitForSolid } from "../solid-settle.ts";
import { agentList } from "./compact.test-support.ts";
import { settleRoster } from "./roster.test-support.ts";

const menuTrigger = ".sidebar-agent-card__main, .sidebar-workspace-header__main";
const avatarImage = ".sidebar-agent-card__avatar img";

async function mountAgent(
  gateway = createGateway({} as GatewayBrowserClient),
  agents: Parameters<typeof mountSidebar>[3] = TWO_AGENTS,
  identity?: Parameters<typeof mountSidebar>[5],
  sessions = createSessions("main", ["agent:main:main"]),
) {
  const mounted = await mountSidebar(gateway, sessions, "panel", agents, [], identity);
  return { ...mounted, dom: domProbe(mounted.sidebar) };
}

async function openAgentMenu(sidebar: Awaited<ReturnType<typeof mountSidebar>>["sidebar"]) {
  sidebar.querySelector<HTMLButtonElement>(menuTrigger)?.click();
  await sidebar.updateComplete;
}

async function mountIdentity(client: GatewayBrowserClient, agents = agentList([{ id: "main" }])) {
  const gateway = createGatewayHarness(client);
  const identity = createAgentIdentityCapability(gateway.gateway);
  return { ...(await mountAgent(gateway.gateway, agents, identity)), gateway, identity };
}

function menuAgent(root: ParentNode, id: string) {
  return [...root.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch")].find((row) =>
    row.textContent?.includes(id),
  );
}

function avatarAgents(avatarUrl: string) {
  return agentList([
    { id: "main", identity: { name: "Molty", emoji: "🦞" } },
    { id: "research", identity: { avatarUrl } },
  ]);
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
      expect(dom.text(".sidebar-agent-card__name")?.trim()).toContain("Workspace Molty");
      expect(dom.query<HTMLImageElement>(avatarImage)?.src).toBe(firstAvatar);
    });
    expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" });
    await settleRoster(sidebar);
    request.mockResolvedValue(next);
    gateway.publishEvent("agent.identity.changed", { agentId: "main" });
    await identity.ensure(["main"]);
    await settleRoster(sidebar);
    expect(dom.text(".sidebar-agent-card__name")).toContain("Updated workspace");
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
    expect(dom.text(".sidebar-agent-card__name")).not.toContain("Private agent");
    if (discovery === "loading") {
      expect(dom.query(".sidebar-agent-card__main")).toBeNull();
      expect(dom.text(".sidebar-recent-session__title-row")).toContain(
        "Existing readable conversation",
      );
    } else {
      expect(dom.attr(".sidebar-agent-card__main", "aria-label")).toMatch(/shared/i);
    }
    dom.query<HTMLButtonElement>(menuTrigger)?.click();
    await vi.dynamicImportSettled();
    await sidebar.updateComplete;
    expect(dom.text(".sidebar-agent-menu")).not.toContain("Private agent");
    expect(dom.query('[data-value="command:new-agent"]')).not.toBeNull();
    expect(dom.query('[data-value="command:agents-directory"]')).toBeNull();
    expect(dom.query('[data-value="command:capabilities"]')).toBeNull();
    expect(dom.query('[data-value="command:agent-settings"]')).toBeNull();
    const sharedSettings = dom.query('[data-value="agent:shared"] .sidebar-agent-menu__settings');
    if (discovery === "loading") {
      expect(sharedSettings).toBeNull();
    } else {
      expect(sharedSettings).not.toBeNull();
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
    await vi.waitFor(() => {
      expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("Workspace Molty");
    });
    dom.query<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "rust-claw" });
      const labels = [...dom.all(".sidebar-agent-menu .agent-select__option-label")].map(
        (element) => element.textContent?.trim(),
      );
      expect(labels).toEqual(["Create new agent", "Show all", "Workspace Molty", "rust-claw"]);
    });
    await vi.waitFor(() => {
      const rustRow = menuAgent(sidebar, "rust-claw");
      expect(rustRow?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
        "🦀",
      );
    });
  });

  it("hydrates agents added while the switcher remains open", async () => {
    const request = vi.fn(async (_method: string, { agentId }: { agentId: string }) => ({
      agentId,
      name: `Workspace ${agentId}`,
    }));
    const { sidebar, context, dom } = await mountIdentity({
      request,
    } as unknown as GatewayBrowserClient);
    sidebar.connected = true;
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" }),
    );
    await openAgentMenu(sidebar);
    expect(dom.query(".sidebar-agent-menu")).not.toBeNull();

    context.agents.state.agentsList = TWO_AGENTS;
    sidebar.invalidate();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "research" });
      expect(dom.text(".sidebar-agent-menu")).toContain("Workspace research");
    });
  });

  it("opens the agent-scoped menu with its inline roster", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    gateway.gateway.setSessionKey = setSessionKey;
    const { sidebar, context, dom } = await mountAgent(
      gateway.gateway,
      avatarAgents("data:image/png;base64,eA=="),
    );
    const onNavigate = vi.fn();
    Object.assign(sidebar, { connected: true, canPairDevice: true, onNavigate });
    await sidebar.updateComplete;

    expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("Molty");
    await openAgentMenu(sidebar);

    const menu = dom.query(".sidebar-agent-menu");
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
    expect(menuDom.all('[role="separator"]')).toHaveLength(0);
    expect(
      [...menuDom.all('[role^="menuitem"]')].map((element) => element.getAttribute("data-value")),
    ).toEqual(["command:new-agent", "scope:all", "agent:main", "agent:research"]);

    const commands = [...menuDom.all('[data-value^="command:"]')];
    expect(commands.map((item) => item.textContent?.trim())).toEqual(["Create new agent"]);
    for (const command of commands) {
      expect(command.querySelector(".sidebar-agent-menu__create-icon svg")).not.toBeNull();
    }

    const agentRows = [...menuDom.all('[data-value^="agent:"]')];
    expect(agentRows).toHaveLength(2);
    expect(agentRows[0]?.classList.contains("sidebar-agent-menu__agent-switch--active")).toBe(true);
    expect(agentRows[0]?.querySelector(".sidebar-agent-menu__agent-row")).not.toBeNull();
    expect(menuDom.attr(".identity-avatar__text", "data-avatar")).toBe("🦞");
    expect(menuDom.query<HTMLImageElement>(".agent-select__avatar img")?.src).toContain(
      "data:image/png;base64,eA==",
    );
    const researchRow = menuAgent(menu!, "research");
    researchRow?.click();
    await sidebar.updateComplete;

    expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: "research" });
    expect(dom.text(".sidebar-agent-card__name")?.trim()).toBe("research");
    // Uncached agents resume Home and ask the Gateway to derive the face.
    expect(setSessionKey).toHaveBeenCalledWith("agent:research:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(dom.query(".sidebar-agent-menu")).toBeNull();
  });

  it.each([
    { viewport: "normal", width: undefined, left: 12, right: 252, x: 12 },
    { viewport: "narrow", width: 280, left: 100, right: 340, x: 8 },
  ])("positions the mobile menu ($viewport viewport)", async ({ width, left, right, x }) => {
    if (width !== undefined) {
      vi.stubGlobal("innerWidth", width);
    }
    const { sidebar, dom, provider } = await mountAgent();
    provider.classList.add("shell--mobile-nav");
    sidebar.connected = true;
    await sidebar.updateComplete;
    const card = dom.query<HTMLButtonElement>(".sidebar-agent-card__main")!;
    expect(card).not.toBeNull();
    card.getBoundingClientRect = () => ({ bottom: 88, left, right, top: 40 }) as DOMRect;
    await openAgentMenu(sidebar);
    expect(sidebar.sidebarMenus.agentMenuPosition).toEqual({ x, top: 92 });
    const menu = dom.query(".sidebar-agent-menu");
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.previousElementSibling?.getAttribute("style")).toContain("top: 92px");
  });

  it("opens the agent menu on right-click without toggling an open menu", async () => {
    const { sidebar, dom } = await mountAgent();
    const card = dom.query<HTMLElement>("openclaw-sidebar-agent-card")!;
    const trigger = card.querySelector<HTMLElement>(".sidebar-agent-card__main")!;
    const label = card.querySelector<HTMLElement>(".sidebar-agent-card__name")!;
    trigger.getBoundingClientRect = () =>
      ({ bottom: 88, left: 12, right: 252, top: 40 }) as DOMRect;

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    label.dispatchEvent(event);
    await sidebar.updateComplete;
    const firstMenu = dom.query(".sidebar-agent-menu");
    expect(event.defaultPrevented).toBe(true);
    expect(firstMenu).not.toBeNull();

    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    expect(dom.query(".sidebar-agent-menu")).toBe(firstMenu);
  });

  it.each([6, 12])(
    "renders %s agents in gateway order without filter or pin controls",
    async (count) => {
      const { sidebar, context, dom } = await mountAgent(
        undefined,
        manyAgents(count),
        undefined,
        createSessions("agent-1", ["agent:agent-1:main"]),
      );
      sidebar.connected = true;
      context.agentSelection.set("agent-1");
      await sidebar.updateComplete;
      await openAgentMenu(sidebar);
      expect(dom.query(".sidebar-agent-menu__filter")).toBeNull();
      expect(dom.query("input")).toBeNull();
      expect(dom.query(".sidebar-agent-menu__pin")).toBeNull();
      expect(dom.query(".sidebar-agent-menu__agent-list")).not.toBeNull();
      expect(
        [...dom.all('.sidebar-agent-menu [data-value^="agent:"] .agent-select__option-label')].map(
          (item) => item.textContent?.trim(),
        ),
      ).toEqual(Array.from({ length: count }, (_, index) => `agent-${index + 1}`));
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
      const { sidebar, dom } = await mountAgent(undefined, avatarAgents(avatarRoute));
      sidebar.connected = true;
      await sidebar.updateComplete;

      await openAgentMenu(sidebar);
      const menu = dom.query(".sidebar-agent-menu");
      const researchRow = menuAgent(menu!, "research");
      const tile = domProbe(researchRow!);
      let avatar = researchRow?.querySelector(".agent-select__avatar");
      expect(avatar?.classList).toContain("is-pending");
      expect(avatar?.classList).not.toContain("is-fallback");

      response.resolve(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      await vi.waitFor(() => {
        expect(tile.attr(".agent-select__avatar img", "src")).toBe("blob:agent-avatar");
      });
      avatar = researchRow?.querySelector(".agent-select__avatar");
      expect(avatar?.classList).not.toContain("is-pending");
      avatar?.querySelector("img")?.dispatchEvent(new Event("load"));
      await waitForSolid(() => expect(avatar?.classList).not.toContain("is-pending"));
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
