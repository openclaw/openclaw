import { describe, expect, it, vi } from "vitest";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  agentIds,
  mountRoster,
  owners,
  roster,
  selectFilter,
  session,
  sessionKeys,
} from "./roster.test-support.ts";

describe("AppSidebar main-chat metadata", () => {
  it("admits reply-only roster changes without remounting a pinned card", async () => {
    const { sidebar, context } = await mountRoster(roster, [session("working", 30)]);
    context.navigation.update({ pinnedAgentIds: ["working"] });
    sidebar.sidebarAgentsMode = "roster";
    const store = rosterActivityStore(context);
    const preview = () =>
      sidebar.querySelector('[data-pinned-agent="working"] .sidebar-pinned-agent__preview');
    await vi.waitFor(() => {
      expect(store.snapshot.membershipReady && !store.snapshot.loading).toBe(true);
      expect(preview()?.textContent).toBe("No agent reply yet");
    });
    const element = preview();
    const settled = store.snapshot;
    // A fast background receipt can arrive between two frames with no change
    // to loading flags or to any visible session row. Only the card text differs.
    sidebar.shouldPublishSessionData();
    expect(sidebar.shouldPublishSessionData()).toBe(false);
    const working = settled.cards.find((card) => card.id === "working")!;
    const replied = { ...working, assistantPreview: "The notes are ready." };
    vi.spyOn(store, "snapshot", "get").mockReturnValue({
      ...settled,
      cards: settled.cards.map((card) => (card === working ? replied : card)),
    });
    sidebar.sessionData.requestSessionDataUpdate();
    await vi.waitFor(() => expect(preview()?.textContent).toBe("The notes are ready."));
    expect(preview()).toBe(element);
  });

  it("updates the assistant preview and removes its line when the session is replaced", async () => {
    const { sidebar, context, result } = await mountRoster(roster, [
      session("working", 10, {
        sessionId: "first",
        lastMessagePreview: "A new user question",
        lastAssistantMessage: { text: "I have set up the template.", timestamp: 9 },
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    const header = () =>
      sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__header')!;
    const preview = () => header()?.querySelector(".sidebar-agent-roster__preview");
    await vi.waitFor(() => expect(preview()?.textContent).toBe("I have set up the template."));
    expect(header().querySelector(".sidebar-agent-roster__name")?.textContent).toBe("Forge");
    expect(header().textContent).not.toContain("A new user question");
    result.sessions = [
      session("working", 20, {
        sessionId: "first",
        lastAssistantMessage: { text: "The template is ready to use.", timestamp: 20 },
      }),
    ];
    await rosterActivityStore(context).refresh();
    await vi.waitFor(() => expect(preview()?.textContent).toBe("The template is ready to use."));
    result.sessions = [
      session("working", 30, {
        sessionId: "replacement",
        lastMessagePreview: "Start a new task",
      }),
    ];
    await rosterActivityStore(context).refresh();
    await vi.waitFor(() => expect(preview()).toBeNull());
    expect(header().querySelector(".sidebar-agent-roster__name")?.textContent).toBe("Forge");
  });

  it("keeps main activity on the avatar without session metadata or disclosure", async () => {
    const { sidebar } = await mountRoster(roster, [
      session("working", 10, {
        owner: { actor: owners[0] },
        worktree: { id: "wt-main", branch: "feature/header", repoRoot: "/repo" },
        icon: "home",
        visibility: "draft",
        hasActiveRun: true,
        status: "queued",
        unread: true,
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    const header = () =>
      sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__header')!;
    await vi.waitFor(() => {
      expect(
        header().querySelector(".sidebar-agent-roster__avatar .session-glyph__ring"),
      ).not.toBeNull();
      expect(header().querySelector(".session-owner-chip")).toBeNull();
      expect(header().querySelector("[data-agent-collapse]")).toBeNull();
      expect(header().querySelector("[data-pull-request-state]")).toBeNull();
      expect(header().querySelector(".sidebar-child-session-toggle__count")).toBeNull();
      expect(header().querySelector(".session-row-badge--draft")).toBeNull();
      expect(header().querySelector('[aria-label="Unread"]')).toBeNull();
      expect(sessionKeys(sidebar)).toEqual([]);
    });
  });

  it("keeps agent navigation without leaking session metadata through owner filters", async () => {
    const { sidebar } = await mountRoster(roster, [
      session("working", 10, {
        owner: { actor: owners[0] },
        incognito: true,
        hasActiveRun: true,
        status: "running",
        unread: true,
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    const header = () =>
      sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__header')!;
    for (const owner of ["profile-sam", "profile-ada", ""] as const) {
      await selectFilter(sidebar, `owner:${owner}`);
      await vi.waitFor(() => {
        expect(header().querySelector(".session-row-badge--incognito")).toBeNull();
        expect(header().querySelector('[aria-label="Unread"]')).toBeNull();
      });
      expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
      expect(sessionKeys(sidebar)).toEqual([]);
    }
  });
});
