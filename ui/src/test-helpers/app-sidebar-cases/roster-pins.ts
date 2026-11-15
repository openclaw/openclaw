import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { domProbe } from "../dom-probe.ts";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

const thread = (id: string, name: string, at: number, extra: Partial<GatewaySessionRow> = {}) =>
  session(id, at, { key: `agent:${id}:${name}`, isMain: false, ...extra });

function mode(sidebar: Parameters<typeof settleRoster>[0], sidebarAgentsMode: "chip" | "roster") {
  sidebar.sidebarAgentsMode = sidebarAgentsMode;
  return settleRoster(sidebar);
}

function pinnedRow(sidebar: HTMLElement, key: string) {
  return sidebar.querySelector(
    `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${key}"]`,
  );
}

function pinnedKeys(sidebar: HTMLElement) {
  return [
    ...sidebar.querySelectorAll<HTMLElement>(
      '[data-session-section="pinned"] .sidebar-recent-session',
    ),
  ].map((row) => row.dataset.sessionKey);
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
  it("hides a snoozed current pin, keeps it discoverable, and restores its saved order on wake", async () => {
    const rows = [
      thread("main", "before", 3),
      thread("main", "snoozed", 2),
      thread("main", "after", 1),
    ];
    const target = rows[1]!;
    const { sidebar, sessions, result } = await mountRoster(roster, rows);
    const entries = rows.map((row) => "session:" + row.key);
    sidebar.sidebarEntries = entries;
    sidebar.sessionKey = target.key;
    await settleRoster(sidebar);
    expect(pinnedKeys(sidebar)).toEqual(rows.map((row) => row.key));

    const publish = async (snoozedUntil: number | undefined) => {
      result.sessions = rows.map((row) =>
        row.key === target.key ? { ...row, snoozedUntil } : row,
      );
      sessions.publishList({ result: { ...result } });
      await settleRoster(sidebar);
    };
    await publish(Date.now() + 3_600_000);
    expect(pinnedKeys(sidebar)).toEqual([rows[0]!.key, rows[2]!.key]);
    expect(sessionKeys(sidebar)).not.toContain(target.key);
    expect(sidebar.sidebarEntries).toEqual(entries);

    for (const filter of ["snoozed", "all"] as const) {
      sidebar.sessionsStatusFilter = filter;
      await settleRoster(sidebar);
      expect(pinnedKeys(sidebar)).not.toContain(target.key);
      expect(sessionKeys(sidebar).filter((key) => key === target.key)).toEqual([target.key]);
    }
    sidebar.sessionsStatusFilter = "active";
    await publish(undefined);
    expect(pinnedKeys(sidebar)).toEqual(rows.map((row) => row.key));
    expect(sidebar.sidebarEntries).toEqual(entries);
  });

  it("wakes a snoozed pin outside the loaded roster from the reactive clock", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(10_000);
    const before = thread("main", "before", 3);
    const target = thread("working", "snoozed", 2, {
      sessionId: "off-roster-snooze",
      snoozedUntil: 11_500,
    });
    const after = thread("main", "after", 1);
    const rows = [before, target, after];
    const { sidebar, request, sessions } = await mountRoster(
      roster,
      [before, after],
      "ws://gateway.test",
      [target],
    );
    const entries = rows.map((row) => "session:" + row.key);
    sidebar.sidebarEntries = entries;
    await settleRoster(sidebar);
    expect(pinnedKeys(sidebar)).toEqual([before.key, after.key]);
    const requests = request.mock.calls.length;
    const lists = sessions.list.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2_000);
    await settleRoster(sidebar);
    expect(pinnedKeys(sidebar)).toEqual(rows.map((row) => row.key));
    expect(sidebar.sidebarEntries).toEqual(entries);
    expect(request).toHaveBeenCalledTimes(requests);
    expect(sessions.list).toHaveBeenCalledTimes(lists);
  });

  it("lists cross-agent pins in saved order in the Pinned section, not the rail", async () => {
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
    expect([...rail].map(({ dataset }) => dataset.sidebarEntry)).toEqual([
      "route:usage",
      "route:plugins",
    ]);
    const pinned = entries.flatMap((entry) =>
      entry.startsWith("session:") ? [entry.slice("session:".length)] : [],
    );
    expect(pinnedKeys(sidebar)).toEqual(pinned);
    for (const [id, face] of [
      ["working", `img.identity-avatar__image[src="${avatarRoute}"]`],
      ["main", '[data-avatar="⚓"]'],
      ["recent", ".identity-avatar__agent-face"],
    ] as const) {
      const pin = pinnedRow(sidebar, `agent:${id}:pinned`)!;
      expect(pin.closest("[data-agent-group]")).toBeNull();
      expect(pin.querySelector(".session-glyph__emoji")?.textContent).toBe("⭐");
      expect(pin.querySelector<HTMLAnchorElement>("a")?.pathname).toBe(`/chat/${id}/pinned`);
      const avatar = dom.query(
        `[data-agent-group="${id}"] .sidebar-agent-roster__header .identity-avatar--agent`,
      );
      expect(avatar!.querySelector(face)).not.toBeNull();
    }
    expect(sessionKeys(sidebar)).toEqual(pinned);
    expect(dom.query("[data-agent-collapse]")).toBeNull();
    await mode(sidebar, "chip");
    // Other agents' pins resolve through descriptors; the loaded row is listed once, first.
    const chipPins = pinnedKeys(sidebar);
    expect(chipPins).toContain("agent:main:pinned");
    expect(sessionKeys(sidebar)).toEqual([...chipPins, "agent:main:recent"]);
    expectChipPin(sidebar);
    expect(sidebar.sidebarEntries).toEqual(entries);

    await mode(sidebar, "roster");
    expect(context.agentSelection.state.selectedId).toBe("main");
    pinnedRow(sidebar, "agent:working:pinned")?.querySelector<HTMLAnchorElement>("a")?.click();
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
      expect(pinnedRow(sidebar, key) !== null).toBe(pinned);
      expect(dom.query(`.sidebar-rail [data-sidebar-entry="session:${key}"]`)).toBeNull();
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
