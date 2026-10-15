import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import {
  agentIds,
  mountRoster,
  roster,
  settleRoster,
  session,
  sessionKeys,
  toggleRoster,
} from "./roster.test-support.ts";

describe("AppSidebar agent roster", () => {
  it("keeps a held row outside the displayed sidebar window current without rendering", async () => {
    const rows = Array.from({ length: SIDEBAR_SESSION_PAGE_SIZE + 3 }, (_, index) =>
      session("main", 100 - index, {
        key: `agent:main:work-${index}`,
        isMain: false,
        label: `Work ${index}`,
      }),
    );
    const { sidebar, sessions } = await mountRoster(roster, [session("main", 0), ...rows]);
    await settleRoster(sidebar);
    const last = rows.at(-1)!;
    expect(sidebar.querySelector(`[data-session-key="${last.key}"]`)).toBeNull();
    const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
    const current = sessions.sessions.state.result!;
    const updated = {
      ...current,
      sessions: current.sessions.map((row) =>
        row.key === last.key ? Object.assign({}, row, { label: "Quiet latest title" }) : row,
      ),
    };
    sessions.publish({ result: updated });
    await settleRoster(sidebar);
    expect(sidebar.sessionData.sessionsResult).toBe(updated);
    expect(prepare).not.toHaveBeenCalled();
    sessions.sessions.setPullRequestSummary(last.key, { numbers: [42], state: "open" });
    await settleRoster(sidebar);
    expect(prepare).not.toHaveBeenCalled();
    sidebar.setVisibleSessionLimit("ungrouped", rows.length);
    await settleRoster(sidebar);
    expect(sidebar.querySelector(`[data-session-key="${last.key}"]`)?.textContent).toContain(
      "Quiet latest title",
    );
  });
  it.each(["navigation", "contextual"] as const)(
    "parks hidden roster publications under %s and reads the latest session state on reveal",
    async (surface) => {
      const { sidebar, context, sessions, result } = await mountRoster();
      await toggleRoster(sidebar);
      await settleRoster(sidebar);
      const store = rosterActivityStore(context);
      onTestFinished(store.subscribe(() => {}));
      const renderedRow = sidebar.querySelector<HTMLElement>(
        '[data-session-key="agent:main:recent"]',
      )!;
      const initial = renderedRow.textContent;
      if (surface === "navigation") {
        sidebar.navigationVisible = false;
      } else {
        sidebar.contextualSidebar = {
          key: "sessions",
          data: null,
          loaderPending: false,
          render: () => null,
        };
      }
      await settleRoster(sidebar);
      const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
      for (let index = 0; index < 3; index += 1) {
        result.sessions = result.sessions.map((heldRow) =>
          heldRow.key === "agent:main:recent"
            ? { ...heldRow, label: `Latest work ${index}`, unread: true, hasActiveRun: true }
            : heldRow,
        );
        sessions.publish({
          result: { ...result, sessions: result.sessions.filter((row) => row.agentId === "main") },
        });
        await store.refresh();
        await settleRoster(sidebar);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(renderedRow.textContent).toBe(initial);
      if (surface === "navigation") {
        sidebar.navigationVisible = true;
      } else {
        sidebar.contextualSidebar = undefined;
      }
      await settleRoster(sidebar);
      expect(
        sidebar.querySelector('[data-session-key="agent:main:recent"]')?.textContent,
      ).toContain("Latest work 2");
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("remembers collapsed agents after remount and keeps chip mode scoped to one agent", async () => {
    const { sidebar, provider, context, result, gatewayHarness } = await mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    sidebar.sidebarEntries = ["session:agent:working:pinned"];
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:working:recent"));
    sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
    await vi.waitFor(() => expect(sessionKeys(sidebar)).not.toContain("agent:working:recent"));
    expect(
      sidebar.querySelector('.sidebar-rail [data-sidebar-entry="session:agent:working:pinned"]'),
    ).not.toBeNull();
    expect(loadSettings().sidebarCollapsedAgentIds).toEqual(["working"]);
    const summary = sidebar.querySelector(
      '[data-agent-group="working"] .sidebar-agent-roster__signals',
    )!;
    expect(summary.querySelectorAll(".session-glyph__ring")).toHaveLength(1);
    for (const [phase, seq] of [
      ["finishing", 1],
      ["start", 2],
    ] as const) {
      gatewayHarness.publishEvent("agent", {
        sessionKey: "agent:working:pinned",
        runId: "collapsed-roster-run",
        seq,
        stream: "lifecycle",
        data: { phase },
      });
      await settleRoster(sidebar);
      expect(result.sessions.find((row) => row.key === "agent:working:pinned")?.hasActiveRun).toBe(
        true,
      );
      expect(
        sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__signals'),
      ).toBe(summary);
      expect(summary.querySelectorAll(".session-glyph__ring")).toHaveLength(1);
    }
    result.sessions = result.sessions.map((row) =>
      row.agentId === "working" && row.isMain === false && row.archived !== true
        ? { ...row, hasActiveRun: false, activeRunIds: [], status: "done", unread: true }
        : row,
    );
    await rosterActivityStore(context).refresh();
    await settleRoster(sidebar);
    expect(
      sidebar.querySelector('[data-agent-group="working"] .sidebar-agent-roster__signals'),
    ).toBe(summary);
    expect(summary.querySelector(".session-glyph__ring")).toBeNull();
    expect(summary.querySelector('[aria-label="Unread"]')?.textContent?.trim()).toBe("2");
    result.sessions = result.sessions.map((row) =>
      row.key === "agent:working:recent"
        ? Object.assign({}, row, {
            placement: {
              state: "reclaimed" as const,
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
              workspaceResultConflict: {
                paths: ["ui/layout.css"],
                totalCount: 3,
                stagedResultRef: "refs/openclaw/worker-results/test",
              },
            },
          })
        : row,
    );
    await rosterActivityStore(context).refresh();
    await settleRoster(sidebar);
    expect(
      summary.querySelector('[aria-label="Cloud worker children: 3 workspace conflicts"]'),
    ).not.toBeNull();
    provider.remove();
    const remounted = await mountRoster();
    remounted.sidebar.sidebarEntries = ["session:agent:working:pinned"];
    remounted.sidebar.sidebarAgentsMode = loadSettings().sidebarAgentsMode ?? "chip";
    await vi.waitFor(() => expect(agentIds(remounted.sidebar)).toHaveLength(3));
    await vi.waitFor(() => expect(sessionKeys(remounted.sidebar)).toContain("agent:recent:recent"));
    expect(
      remounted.sidebar
        .querySelector('[data-agent-collapse="working"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(sessionKeys(remounted.sidebar)).not.toContain("agent:working:recent");
    expect(
      remounted.sidebar.querySelector(
        '.sidebar-rail [data-sidebar-entry="session:agent:working:pinned"]',
      ),
    ).not.toBeNull();
    await toggleRoster(remounted.sidebar);
    await vi.waitFor(() =>
      expect(remounted.sidebar.querySelector(".sidebar-agent-roster")).toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(sessionKeys(remounted.sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
  });
});
