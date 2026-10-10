import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

describe("AppSidebar agent roster pins", () => {
  it("keeps cross-agent pins in Pages in saved order with their owning avatars", async () => {
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
    const entries = [
      "route:usage",
      "session:agent:working:pinned",
      "route:plugins",
      "session:agent:main:pinned",
      "session:agent:recent:pinned",
    ];
    sidebar.sidebarEntries = entries;
    await sidebar.updateComplete;
    const chipLead = sidebar.querySelector(
      '[data-session-key="agent:main:pinned"] .sidebar-session-indicator',
    );
    expect(chipLead).not.toBeNull();
    expect(chipLead?.querySelector(".identity-avatar--agent")).toBeNull();
    expect(chipLead?.querySelector(".session-glyph__emoji")?.textContent).toBe("⭐");
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);

    expect(
      [...sidebar.querySelectorAll<HTMLElement>(".sidebar-nav [data-sidebar-entry]")].map(
        (entry) => entry.dataset.sidebarEntry,
      ),
    ).toEqual(entries);
    for (const id of ["working", "main", "recent"]) {
      const rows = sidebar.querySelectorAll(`[data-session-key="agent:${id}:pinned"]`);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.closest(".sidebar-nav")).not.toBeNull();
      expect(row?.closest("[data-agent-group]")).toBeNull();
      expect(row?.hasAttribute("role")).toBe(false);
      expect(row?.closest(".sidebar-session-tree")?.hasAttribute("role")).toBe(false);
      const avatar = row?.querySelector(".sidebar-session-indicator .identity-avatar--agent");
      expect(avatar).not.toBeNull();
      expect(row?.querySelector(".sidebar-session-indicator .session-glyph__emoji")).toBeNull();
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
    expect(sidebar.querySelectorAll("[data-agent-group] .session-row-host--pinned")).toHaveLength(
      0,
    );
    expect(sessionKeys(sidebar)).not.toContain("agent:system:pinned");
    expect(
      sidebar.querySelector(
        '[data-agent-group="main"] [data-session-key="agent:main:recent"] .session-glyph__emoji',
      )?.textContent,
    ).toBe("📝");
    sidebar.sidebarAgentsMode = "chip";
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:pinned"] .sidebar-session-indicator .identity-avatar--agent',
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:pinned"] .sidebar-session-indicator .session-glyph__emoji',
      )?.textContent,
    ).toBe("⭐");
    expect(sidebar.sidebarEntries).toEqual(entries);

    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    expect(context.agentSelection.state.selectedId).toBe("main");
    sidebar
      .querySelector<HTMLAnchorElement>(
        '.sidebar-nav [data-session-key="agent:working:pinned"] .sidebar-recent-session__link',
      )
      ?.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state.selectedId).toBe("working");
    expect(onNavigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working/pinned" }),
    );
    expect(sidebar.sidebarEntries).toEqual(entries);
  });

  it("moves cross-agent pins between Pages and their group after pin and unpin", async () => {
    const key = "agent:working:task";
    const { sidebar, context, sessions, result } = await mountRoster(roster, [
      session("working", 2, { key, isMain: false }),
    ]);
    const entries = ["route:usage", `session:${key}`, "route:plugins"];
    sidebar.sidebarEntries = entries;
    const onUpdate = vi.fn((next: string[]) => {
      sidebar.sidebarEntries = next;
    });
    sidebar.onUpdateSidebarEntries = onUpdate;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    for (const pinned of [true, false]) {
      const source = pinned ? '[data-agent-group="working"]' : ".sidebar-nav";
      const pin = sidebar.querySelector<HTMLButtonElement>(
        `${source} [data-session-key="${key}"] .session-action--pin`,
      );
      expect(pin).not.toBeNull();
      expect(pin?.disabled).toBe(false);
      pin?.click();
      await settleRoster(sidebar);
      expect(sessions.patch).toHaveBeenLastCalledWith(
        key,
        { pinned },
        expect.objectContaining({ agentId: "working" }),
      );
      // The harness patch spy does not publish Gateway rows; supply its canonical readback.
      result.sessions = result.sessions.map((row) => Object.assign({}, row, { pinned }));
      await rosterActivityStore(context).refresh();
      await settleRoster(sidebar);
      const rows = sidebar.querySelectorAll(`[data-session-key="${key}"]`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest(".sidebar-nav") !== null).toBe(pinned);
      expect(rows[0]?.closest('[data-agent-group="working"]') !== null).toBe(!pinned);
      expect(context.agentSelection.state.selectedId).toBe("main");
    }
    expect(onUpdate).toHaveBeenLastCalledWith(["route:usage", "route:plugins"]);
    expect(sidebar.sidebarEntries).toEqual(["route:usage", "route:plugins"]);
  });

  it("keeps a pinned tree in Pages when its agent group is collapsed", async () => {
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
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(sidebar);
    const toggle = sidebar.querySelector<HTMLButtonElement>(
      `.sidebar-nav [data-child-session-toggle="${parentKey}"]`,
    );
    expect(toggle).not.toBeNull();
    toggle?.click();
    await settleRoster(sidebar);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(sessionKeys(sidebar)).toEqual([parentKey, childKey, "agent:working:notes"]);
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual([parentKey, childKey]);
    expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1);
    const child = sidebar.querySelector(`[data-session-key="${childKey}"]`);
    expect(child?.closest(".sidebar-nav")).not.toBeNull();
    expect(child?.closest("[data-agent-group]")).toBeNull();
    expect(child?.classList.contains("sidebar-recent-session--child")).toBe(true);
    expect(child?.querySelector(".sidebar-session-indicator .identity-avatar--agent")).toBeNull();
    toggle?.click();
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar)).toEqual([parentKey]);
  });
});
