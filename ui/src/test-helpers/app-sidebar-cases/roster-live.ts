import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { createSidebarTestRouter } from "../app-sidebar-router.ts";
import * as R from "./roster.test-support.ts";

describe("AppSidebar agent roster", () => {
  it("keeps a held row outside the displayed sidebar window current without rendering", async () => {
    const rows = Array.from({ length: SIDEBAR_SESSION_PAGE_SIZE + 3 }, (_, index) =>
      R.session("main", 100 - index, {
        key: `agent:main:work-${index}`,
        isMain: false,
        label: `Work ${index}`,
      }),
    );
    const { sidebar, sessions } = await R.mountRoster(R.roster, [R.session("main", 0), ...rows]);
    await R.settleRoster(sidebar);
    const last = rows.at(-1)!;
    expect(sidebar.querySelector(`[data-session-key="${last.key}"]`)).toBeNull();
    const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
    const current = sessions.sessions.state.result!;
    const updated = {
      ...current,
      sessions: R.patchRows(current.sessions, last.key, { label: "Quiet latest title" }),
    };
    sessions.publish({ result: updated });
    await R.settleRoster(sidebar);
    expect(sidebar.sessionData.sessionsResult).toBe(updated);
    expect(prepare).not.toHaveBeenCalled();
    sessions.sessions.setPullRequestSummary(last.key, { numbers: [42], state: "open" });
    await R.settleRoster(sidebar);
    expect(prepare).not.toHaveBeenCalled();
    sidebar.setVisibleSessionLimit("ungrouped", rows.length);
    await R.settleRoster(sidebar);
    expect(sidebar.querySelector(`[data-session-key="${last.key}"]`)?.textContent).toContain(
      "Quiet latest title",
    );
  });
  it.each(["navigation", "contextual"] as const)(
    "parks hidden roster publications under %s and reads the latest session state on reveal",
    async (surface) => {
      const { sidebar, context, sessions, result } = await R.mountRoster();
      await R.toggleRoster(sidebar);
      await R.settleRoster(sidebar);
      const store = rosterActivityStore(context);
      onTestFinished(store.subscribe(() => {}));
      const renderedRow = sidebar.querySelector<HTMLElement>('[data-agent-group="main"]')!;
      const initial = renderedRow.textContent;
      const router = createSidebarTestRouter();
      if (surface === "navigation") {
        sidebar.navigationVisible = false;
      } else {
        sidebar.router = router;
        await router.navigate("systems", {});
      }
      await R.settleRoster(sidebar);
      const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
      for (let index = 0; index < 3; index += 1) {
        result.sessions = R.patchRows(result.sessions, "agent:main:recent", {
          lastAssistantMessage: { text: `Latest work ${index}`, timestamp: index + 1 },
        });
        sessions.publish({
          result: { ...result, sessions: result.sessions.filter((row) => row.agentId === "main") },
        });
        await store.refresh();
        await R.settleRoster(sidebar);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(renderedRow.textContent).toBe(initial);
      if (surface === "navigation") {
        sidebar.navigationVisible = true;
      } else {
        await router.navigate("cron", {});
      }
      await R.settleRoster(sidebar);
      expect(
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__preview')
          ?.textContent,
      ).toContain("Latest work 2");
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("retains agent-only mode after remount, then restores chip sessions", async () => {
    const { sidebar, provider } = await R.mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
    expect(R.sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    await R.toggleRoster(sidebar);
    await vi.waitFor(() => expect(R.agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    expect(R.sessionKeys(sidebar)).toEqual([]);
    expect(sidebar.querySelector("[data-agent-collapse]")).toBeNull();
    provider.remove();
    const remounted = await R.mountRoster();
    remounted.sidebar.sidebarAgentsMode = loadSettings().sidebarAgentsMode ?? "chip";
    await vi.waitFor(() => expect(R.agentIds(remounted.sidebar)).toHaveLength(3));
    expect(R.sessionKeys(remounted.sidebar)).toEqual([]);
    await R.toggleRoster(remounted.sidebar);
    await vi.waitFor(() =>
      expect(remounted.sidebar.querySelector(".sidebar-agent-roster")).toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(R.sessionKeys(remounted.sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
  });
});
