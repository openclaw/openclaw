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

describe("AppSidebar agent-only roster", () => {
  it("shows configured agents, recent assistant text, and one run ring without session trees", async () => {
    const { sidebar, context, result } = await mountRoster(roster, [
      session("main", 10, { lastAssistantMessage: { text: "Ready to review.", timestamp: 10 } }),
      session("working", 11, {
        key: "agent:working:project",
        isMain: false,
        hasActiveRun: true,
        status: "running",
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]));
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
