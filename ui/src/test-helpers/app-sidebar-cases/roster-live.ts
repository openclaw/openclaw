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
      const renderedRow = sidebar.querySelector<HTMLElement>('[data-agent-group="main"]')!;
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
            ? {
                ...heldRow,
                lastAssistantMessage: { text: `Latest work ${index}`, timestamp: index + 1 },
              }
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
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__preview')
          ?.textContent,
      ).toContain("Latest work 2");
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("retains agent-only mode after remount, then restores chip sessions", async () => {
    const { sidebar, provider } = await mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    expect(sessionKeys(sidebar)).toEqual([]);
    expect(sidebar.querySelector("[data-agent-collapse]")).toBeNull();
    provider.remove();
    const remounted = await mountRoster();
    remounted.sidebar.sidebarAgentsMode = loadSettings().sidebarAgentsMode ?? "chip";
    await vi.waitFor(() => expect(agentIds(remounted.sidebar)).toHaveLength(3));
    expect(sessionKeys(remounted.sidebar)).toEqual([]);
    await toggleRoster(remounted.sidebar);
    await vi.waitFor(() =>
      expect(remounted.sidebar.querySelector(".sidebar-agent-roster")).toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(sessionKeys(remounted.sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
  });
});
