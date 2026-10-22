import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { domProbe } from "../dom-probe.ts";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

const thread = (id: string, name: string, at: number, extra: Partial<GatewaySessionRow> = {}) =>
  session(id, at, { key: `agent:${id}:${name}`, isMain: false, ...extra });

function mode(sidebar: Parameters<typeof settleRoster>[0], sidebarAgentsMode: "chip" | "roster") {
  sidebar.sidebarAgentsMode = sidebarAgentsMode;
  return settleRoster(sidebar);
}

function railPin(sidebar: HTMLElement, key: string) {
  return sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"]`);
}

function expectChipPin(sidebar: HTMLElement) {
  const lead = sidebar.querySelector(
    '[data-session-key="agent:main:pinned"] .sidebar-session-indicator',
  );
  const glyph = domProbe(lead!);
  expect(glyph.query(".identity-avatar--agent")).toBeNull();
  expect(glyph.text(".session-glyph__emoji")).toBe("⭐");
}

describe("AppSidebar agent roster pins", () => {
  it("keeps cross-agent icon shortcuts in saved order with their session glyphs and routes", async () => {
    const avatarRoute = "/avatar/working?v=pinned-roster";
    const parentKey = "agent:working:pinned";
    const childKey = "agent:recent:recent";
    const agents = structuredClone(roster);
    agents.agents.find(({ id }) => id === "working")!.identity = { avatarUrl: avatarRoute };
    const { sidebar, context } = await mountRoster(
      agents,
      agents.agents.flatMap((agent, index) => [
        thread(agent.id, "pinned", 10 - index, {
          pinned: true,
          icon: "⭐",
          ...(agent.id === "working" ? { childSessions: [childKey] } : {}),
        }),
        thread(agent.id, "recent", 5 - index, {
          icon: "📝",
          ...(agent.id === "recent" ? { spawnedBy: parentKey } : {}),
        }),
      ]),
    );
    const dom = domProbe(sidebar);
    const entries = [
      "route:usage",
      "session:agent:working:pinned",
      "route:plugins",
      "session:agent:main:pinned",
      "session:agent:recent:pinned",
    ];
    sidebar.sidebarEntries = entries;
    await sidebar.updateComplete;
    expectChipPin(sidebar);
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await mode(sidebar, "roster");

    const rail = dom.all<HTMLElement>(".sidebar-rail [data-sidebar-entry]");
    expect([...rail].map(({ dataset }) => dataset.sidebarEntry)).toEqual(entries);
    for (const [id, face] of [
      ["working", `img.identity-avatar__image[src="${avatarRoute}"]`],
      ["main", '[data-avatar="⚓"]'],
      ["recent", ".identity-avatar__agent-face"],
    ] as const) {
      const pin = railPin(sidebar, `agent:${id}:pinned`)!;
      expect(pin.closest("[data-agent-group]")).toBeNull();
      expect(pin.querySelector(".sidebar-recent-session")).toBeNull();
      expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe("⭐");
      expect(pin.querySelector<HTMLAnchorElement>("a")?.pathname).toBe(`/chat/${id}/pinned`);
      const avatar = dom.query(
        `[data-agent-group="${id}"] .sidebar-agent-roster__header .identity-avatar--agent`,
      );
      expect(avatar!.querySelector(face)).not.toBeNull();
    }
    expect(sessionKeys(sidebar)).toEqual([]);
    expect(dom.query("[data-agent-collapse]")).toBeNull();
    await mode(sidebar, "chip");
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    expectChipPin(sidebar);
    expect(sidebar.sidebarEntries).toEqual(entries);

    await mode(sidebar, "roster");
    expect(context.agentSelection.state.selectedId).toBe("main");
    railPin(sidebar, "agent:working:pinned")?.querySelector<HTMLAnchorElement>("a")?.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state.selectedId).toBe("working");
    expect(onNavigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working/pinned" }),
    );
    expect(sidebar.sidebarEntries).toEqual(entries);
  });

  it("toggles personal shortcuts from a session row while keeping the agent-only roster", async () => {
    const key = "agent:main:task";
    const { sidebar, context, sessions, result } = await mountRoster(roster, [
      thread("main", "task", 2),
    ]);
    const dom = domProbe(sidebar);
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn((next: string[]) => {
      sidebar.sidebarEntries = next;
    });
    sidebar.onUpdateSidebarEntries = onUpdate;
    await settleRoster(sidebar);
    for (const pinned of [true, false]) {
      const pin = dom.query<HTMLButtonElement>(`[data-session-key="${key}"] .session-action--pin`)!;
      expect(pin).toMatchObject({ disabled: false });
      pin.click();
      await settleRoster(sidebar);
      expect(sessions.patch).not.toHaveBeenCalled();
      expect(result.sessions[0]?.pinned).not.toBe(true);
      expect(sidebar.sidebarEntries.includes(`session:${key}`)).toBe(pinned);
      expect(railPin(sidebar, key) !== null).toBe(pinned);
      const rows = dom.all(`[data-session-key="${key}"]`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.classList.contains("session-row-host--pinned")).toBe(pinned);
      expect(context.agentSelection.state.selectedId).toBe("main");
    }
    expect(onUpdate).toHaveBeenLastCalledWith(["route:usage", "route:plugins"]);
    expect(sidebar.sidebarEntries).toEqual(["route:usage", "route:plugins"]);
    await mode(sidebar, "roster");
    expect(sessionKeys(sidebar)).toEqual([]);
  });
});
