import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import * as R from "./roster.test-support.ts";

async function mountWorking(extra: Partial<GatewaySessionRow>) {
  const mounted = await R.mountRoster(R.roster, [R.session("working", 10, extra)]);
  mounted.sidebar.sidebarAgentsMode = "roster";
  const header = () =>
    mounted.sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__header')!;
  const part = (name: string) => header().querySelector(`.sidebar-agent-roster__${name}`);
  return { ...mounted, header, part };
}
const hiddenMetadata =
  ".session-owner-chip, [data-agent-collapse], [data-pull-request-state], " +
  '.sidebar-child-session-toggle__count, .session-row-badge--draft, [aria-label="Unread"]';

it("AppSidebar refreshes the preview and clears it on session replacement", async () => {
  const { context, result, header, part } = await mountWorking({
    sessionId: "first",
    lastMessagePreview: "Question",
    lastAssistantMessage: { text: "First reply", timestamp: 9 },
  });
  await vi.waitFor(() => expect(part("preview")?.textContent).toBe("First reply"));
  expect(part("name")?.textContent).toBe("Forge");
  expect(header().textContent).not.toContain("Question");
  const replace = async (time: number, extra: Partial<GatewaySessionRow>) => {
    result.sessions = [R.session("working", time, extra)];
    await rosterActivityStore(context).refresh();
  };
  await replace(20, {
    sessionId: "first",
    lastAssistantMessage: { text: "Second reply", timestamp: 20 },
  });
  await vi.waitFor(() => expect(part("preview")?.textContent).toBe("Second reply"));
  await replace(30, { sessionId: "replacement", lastMessagePreview: "Restart" });
  await vi.waitFor(() => expect(part("preview")).toBeNull());
  expect(part("name")?.textContent).toBe("Forge");
});

it.each([false, true])("AppSidebar keeps headers private (filtered: %s)", async (filtered) => {
  const extra: Partial<GatewaySessionRow> = filtered
    ? { incognito: true, status: "running" }
    : {
        worktree: { id: "wt-main", branch: "feature/header", repoRoot: "/repo" },
        icon: "home",
        visibility: "draft",
        status: "queued",
      };
  const { sidebar, header, part } = await mountWorking({
    owner: { actor: R.owners[0] },
    hasActiveRun: true,
    unread: true,
    ...extra,
  });
  await vi.waitFor(() => expect(R.agentIds(sidebar)).toHaveLength(3));
  if (!filtered) {
    await vi.waitFor(() => {
      expect(part("avatar .session-glyph__ring")).not.toBeNull();
      expect(header().querySelector(hiddenMetadata)).toBeNull();
      expect(R.sessionKeys(sidebar)).toEqual([]);
    });
    return;
  }
  for (const owner of ["profile-sam", "profile-ada", ""]) {
    await R.selectFilter(sidebar, `owner:${owner}`);
    await vi.waitFor(() =>
      expect(
        header().querySelector('.session-row-badge--incognito, [aria-label="Unread"]'),
      ).toBeNull(),
    );
    expect(R.agentIds(sidebar)).toEqual(["main", "recent", "working"]);
    expect(R.sessionKeys(sidebar)).toEqual([]);
  }
});
