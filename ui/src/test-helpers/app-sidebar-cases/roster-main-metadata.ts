import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
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

async function mountWorking(extra: Partial<GatewaySessionRow>) {
  const mounted = await mountRoster(roster, [session("working", 10, extra)]);
  mounted.sidebar.sidebarAgentsMode = "roster";
  const header = () =>
    mounted.sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__header')!;
  return {
    ...mounted,
    header,
    preview: () => header()?.querySelector(".sidebar-agent-roster__preview"),
  };
}
const hiddenMetadata =
  ".session-owner-chip, [data-agent-collapse], [data-pull-request-state], " +
  '.sidebar-child-session-toggle__count, .session-row-badge--draft, [aria-label="Unread"]';

describe("AppSidebar main-chat metadata", () => {
  it("updates the assistant preview and removes its line when the session is replaced", async () => {
    const { context, result, header, preview } = await mountWorking({
      sessionId: "first",
      lastMessagePreview: "A new user question",
      lastAssistantMessage: { text: "I have set up the template.", timestamp: 9 },
    });
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
    const { sidebar, header } = await mountWorking({
      owner: { actor: owners[0] },
      worktree: { id: "wt-main", branch: "feature/header", repoRoot: "/repo" },
      icon: "home",
      visibility: "draft",
      hasActiveRun: true,
      status: "queued",
      unread: true,
    });
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    await vi.waitFor(() => {
      expect(
        header().querySelector(".sidebar-agent-roster__avatar .session-glyph__ring"),
      ).not.toBeNull();
      expect(header().querySelector(hiddenMetadata)).toBeNull();
      expect(sessionKeys(sidebar)).toEqual([]);
    });
  });

  it("keeps agent navigation without leaking session metadata through owner filters", async () => {
    const { sidebar, header } = await mountWorking({
      owner: { actor: owners[0] },
      incognito: true,
      hasActiveRun: true,
      status: "running",
      unread: true,
    });
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    for (const owner of ["profile-sam", "profile-ada", ""] as const) {
      await selectFilter(sidebar, `owner:${owner}`);
      await vi.waitFor(() =>
        expect(
          header().querySelector('.session-row-badge--incognito, [aria-label="Unread"]'),
        ).toBeNull(),
      );
      expect(agentIds(sidebar)).toEqual(["main", "recent", "working"]);
      expect(sessionKeys(sidebar)).toEqual([]);
    }
  });
});
