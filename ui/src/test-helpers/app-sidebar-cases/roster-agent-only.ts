import { describe, expect, it, vi } from "vitest";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  agentIds,
  mountRoster,
  roster,
  session,
  sessionKeys,
  settleRoster,
} from "./roster.test-support.ts";

describe("AppSidebar agent roster", () => {
  it("shows sessions from multiple agents below the roster and preserves agent summaries when collapsed", async () => {
    const agents = structuredClone(roster);
    agents.agents.find(({ id }) => id === "working")!.identity = { emoji: "🔥" };
    const { sidebar, context, result } = await mountRoster(agents, [
      session("main", 10, { lastAssistantMessage: { text: "Ready to review.", timestamp: 10 } }),
      session("main", 9, { key: "agent:main:notes", isMain: false }),
      session("working", 11, {
        key: "agent:working:project",
        isMain: false,
        hasActiveRun: true,
        status: "running",
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]));
    const section = sidebar.querySelector('[data-session-section="roster-sessions"]')!;
    const disclosure = section.querySelector<HTMLButtonElement>('button[aria-label="Sessions"]')!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(sessionKeys(sidebar).toSorted()).toEqual(["agent:main:notes", "agent:working:project"]);
    for (const [key, avatar] of [
      ["agent:main:notes", "⚓"],
      ["agent:working:project", "🔥"],
    ]) {
      await vi.waitFor(() =>
        expect(
          section
            .querySelector(`[data-session-key="${key}"] .sidebar-session-indicator [data-avatar]`)
            ?.getAttribute("data-avatar"),
          key,
        ).toBe(avatar),
      );
    }
    disclosure.click();
    await settleRoster(sidebar);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(sessionKeys(sidebar)).toEqual([]);
    expect(sidebar.querySelector("[data-agent-collapse]")).toBeNull();
    expect(
      sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__preview')
        ?.textContent,
    ).toBe("Ready to review.");
    const working = () => sidebar.querySelector('[data-agent-group="working"]')!;
    expect(
      working().querySelectorAll(".sidebar-agent-roster__avatar .session-glyph__ring"),
    ).toHaveLength(1);
    expect(
      working().querySelector(".sidebar-agent-roster__signals .session-glyph__ring"),
    ).toBeNull();
    expect(working().querySelector(".sidebar-child-session-toggle__count")).toBeNull();

    result.sessions = result.sessions.map((row) =>
      row.agentId === "working"
        ? Object.assign({}, row, { hasActiveRun: false, status: "done" })
        : row,
    );
    await rosterActivityStore(context).refresh();
    await settleRoster(sidebar);
    expect(
      working().querySelector(".sidebar-agent-roster__avatar .session-glyph__ring"),
    ).toBeNull();
    expect(sessionKeys(sidebar)).toEqual([]);
    disclosure.click();
    await settleRoster(sidebar);
    expect(sessionKeys(sidebar).toSorted()).toEqual(["agent:main:notes", "agent:working:project"]);
  });

  it("offers a counted sessions route without a nested-session or create action", async () => {
    const { sidebar, context } = await mountRoster();
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    const header = sidebar.querySelector(
      '[data-agent-group="working"] .sidebar-agent-roster__header',
    )!;
    const trigger = header.querySelector<HTMLButtonElement>(".oc-menu-trigger")!;
    trigger.click();
    await vi.waitFor(() =>
      expect(header.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
    );
    const items = [...header.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    expect(items.map((item) => item.getAttribute("data-value"))).toEqual([
      "pin",
      "sessions",
      "settings",
      "delete",
    ]);
    expect(items.find((item) => item.dataset.value === "sessions")?.textContent).toContain(
      "Sessions",
    );
    items.find((item) => item.dataset.value === "sessions")?.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state.scopeId).toBe("working");
    expect(onNavigate).toHaveBeenCalledWith("sessions");
  });
});
