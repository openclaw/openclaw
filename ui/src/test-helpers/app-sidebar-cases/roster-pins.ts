import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { domProbe } from "../dom-probe.ts";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

function railPin(sidebar: HTMLElement, key: string) {
  return sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"]`);
}

function expectChipPin(sidebar: HTMLElement) {
  const lead = sidebar.querySelector(
    '[data-session-key="agent:main:pinned"] .sidebar-session-indicator',
  );
  expect(lead).not.toBeNull();
  const glyph = domProbe(lead!);
  expect(glyph.query(".identity-avatar--agent")).toBeNull();
  expect(glyph.text(".session-glyph__emoji")).toBe("⭐");
}

describe("AppSidebar agent roster pins", () => {
  it("keeps cross-agent icon shortcuts in saved order with their session glyphs and routes", async () => {
    const avatarRoute = "/avatar/working?v=pinned-roster";
    const agents: AgentsListResult = {
      ...roster,
      agents: roster.agents.map((agent) =>
        agent.id === "working" ? { ...agent, identity: { avatarUrl: avatarRoute } } : agent,
      ),
    };
    const { sidebar, context } = await mountRoster(
      agents,
      agents.agents.flatMap((agent, index) => [
        session(agent.id, 10 - index, {
          key: `agent:${agent.id}:pinned`,
          isMain: false,
          pinned: true,
          icon: "⭐",
        }),
        session(agent.id, 5 - index, {
          key: `agent:${agent.id}:recent`,
          isMain: false,
          icon: "📝",
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
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    expect(
      [...dom.all<HTMLElement>(".sidebar-rail [data-sidebar-entry]")].map(
        (entry) => entry.dataset.sidebarEntry,
      ),
    ).toEqual(entries);
    for (const id of ["working", "main", "recent"]) {
      const pin = railPin(sidebar, `agent:${id}:pinned`)!;
      expect(pin).not.toBeNull();
      expect(pin.closest("[data-agent-group]")).toBeNull();
      expect(pin.querySelector(".sidebar-recent-session")).toBeNull();
      expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe("⭐");
      const link = pin.querySelector<HTMLAnchorElement>("a")!;
      expect(new URL(link.href).pathname).toBe(`/chat/${id}/pinned`);
      const avatar = dom.query(
        `[data-agent-group="${id}"] .sidebar-agent-roster__header .identity-avatar--agent`,
      );
      expect(avatar).not.toBeNull();
      if (id === "working") {
        expect(avatar?.querySelector("img.identity-avatar__image")?.getAttribute("src")).toBe(
          avatarRoute,
        );
      } else if (id === "main") {
        expect(avatar?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("⚓");
      } else {
        expect(avatar?.querySelector(".identity-avatar__agent-face")).not.toBeNull();
      }
    }
    expect(sessionKeys(sidebar)).toEqual([]);
    sidebar.sidebarAgentsMode = "chip";
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    expectChipPin(sidebar);
    expect(sidebar.sidebarEntries).toEqual(entries);

    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
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
      session("main", 2, { key, isMain: false }),
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
      expect(pin).not.toBeNull();
      expect(pin.disabled).toBe(false);
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
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual([]);
  });

  it("keeps a cross-agent rail shortcut reachable without a nested session tree", async () => {
    const parentKey = "agent:working:project";
    const childKey = "agent:recent:child";
    const { sidebar } = await mountRoster(roster, [
      session("working", 3, {
        key: parentKey,
        isMain: false,
        pinned: true,
        childSessions: [childKey],
      }),
      session("recent", 2, { key: childKey, isMain: false, spawnedBy: parentKey }),
      session("working", 1, { key: "agent:working:notes", isMain: false }),
    ]);
    const dom = domProbe(sidebar);
    sidebar.sidebarEntries = [`session:${parentKey}`];
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual([]);
    expect(dom.query("[data-agent-collapse]")).toBeNull();
    const link = railPin(sidebar, parentKey)?.querySelector<HTMLAnchorElement>("a");
    expect(link).not.toBeNull();
    expect(new URL(link!.href).pathname).toBe("/chat/working/project");
  });
});
