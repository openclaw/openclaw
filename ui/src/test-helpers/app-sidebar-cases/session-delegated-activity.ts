import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import { mountRoster, roster, session } from "./roster.test-support.ts";

describe("AppSidebar delegated activity", () => {
  it("loads hidden subagent activity for the selected parent without adding navigation rows", async () => {
    const parentKey = "agent:main:review-parent";
    const childKey = "agent:main:subagent:review-child";
    const sessions = createSessionsHarness("main", [parentKey]);
    const result = sessions.sessions.state.result!;
    const parentRow = result.sessions[0]!;
    Object.assign(parentRow, {
      label: "Review release",
      status: "done",
      hasActiveRun: false,
      childSessions: [childKey],
    });
    const child: GatewaySessionRow = {
      key: childKey,
      kind: "direct",
      spawnedBy: parentKey,
      updatedAt: 2,
      status: "running",
      hasActiveRun: true,
    };
    sessions.list.mockResolvedValue({ ...result, sessions: [child] });
    const gateway = createGatewayHarness(
      createTestGatewayClient(async () => ({ session: parentRow })),
    );
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = parentKey;
    const parent = () => sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
    await waitForFast(() =>
      expect(
        parent().querySelector('.session-glyph__ring[aria-label="Subagents working"]'),
      ).not.toBeNull(),
    );
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(sidebar.querySelector("[data-child-session-toggle]")).toBeNull();

    const finished: GatewaySessionRow = {
      ...child,
      status: "done",
      hasActiveRun: false,
      updatedAt: 3,
    };
    sessions.list.mockResolvedValue({ ...result, ts: 3, sessions: [finished] });
    gateway.publishEvent("sessions.changed", {
      sessionKey: childKey,
      session: finished,
    });
    await waitForFast(() => expect(parent().querySelector(".session-glyph__ring")).toBeNull());
  });

  it("keeps subagent runs out of the session tree while preserving parent activity and failure attention", async () => {
    const parentKey = "agent:main:dashboard:release";
    const childKey = "agent:main:subagent:review";
    const sessions = createSessionsHarness("main", [parentKey, childKey]);
    const result = sessions.sessions.state.result!;
    const parentRow = result.sessions[0]!;
    const runRow = result.sessions[1]!;
    Object.assign(parentRow, {
      label: "Prepare release",
      status: "done",
      hasActiveRun: false,
      childSessions: [childKey],
    });
    Object.assign(runRow, {
      label: "Review changes",
      spawnedBy: parentKey,
      status: "running",
      hasActiveRun: true,
    });
    const { sidebar, provider } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      sessions.sessions,
    );
    const parent = () => sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
    expect(
      parent().querySelector('.session-glyph__ring[aria-label="Subagents working"]'),
    ).not.toBeNull();
    expect(parent().classList.contains("session-row-host--running")).toBe(true);
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(
      sidebar.querySelector("[data-child-session-toggle], [data-show-more-children]"),
    ).toBeNull();
    expect(sessions.list).not.toHaveBeenCalled();

    const failedRun: GatewaySessionRow = {
      ...runRow,
      hasActiveRun: false,
      status: "failed",
      endedAt: 3,
      updatedAt: 3,
      lastRunError: "Review failed",
    };
    sessions.publishList({
      result: {
        ...result,
        ts: 3,
        sessions: [parentRow, failedRun],
      },
    });
    await sidebar.updateComplete;
    expect(parent().querySelector(".session-glyph__ring")).toBeNull();
    expect(parent().querySelector('[data-session-attention="error"]')).not.toBeNull();
    expect(parent().textContent).toContain("Child session Review changes failed: Review failed");
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(
      sidebar.querySelector("[data-child-session-toggle], [data-show-more-children]"),
    ).toBeNull();
    expect(sessions.list).not.toHaveBeenCalled();
    provider.remove();

    const persistentKey = "agent:main:dashboard:implementation";
    const rosterRows = [
      {
        ...parentRow,
        agentId: "main",
        unread: false,
        childSessions: [childKey, persistentKey],
      },
      { ...runRow, agentId: "main", unread: true },
      session("main", 2, {
        key: persistentKey,
        isMain: false,
        spawnedBy: parentKey,
        label: "Implement release",
        status: "done",
        hasActiveRun: false,
      }),
    ];
    const mixed = await mountRoster(
      roster,
      rosterRows,
      undefined,
      rosterRows,
      [],
      rosterRows.filter((row) => row.key !== parentKey),
    );
    mixed.sidebar.sidebarAgentsMode = "roster";
    const rosterParent = () => mixed.sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
    await waitForFast(() =>
      expect(mixed.sidebar.querySelector('[data-agent-collapse="main"]')).not.toBeNull(),
    );
    await waitForFast(() => expect(rosterParent()).not.toBeNull());
    mixed.sidebar
      .querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)!
      .click();
    await waitForFast(() =>
      expect(mixed.sidebar.querySelector(`[data-session-key="${persistentKey}"]`)).not.toBeNull(),
    );
    expect(
      rosterParent().querySelector("[data-child-session-toggle]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      rosterParent().querySelector(".sidebar-session-team-state .session-glyph__ring"),
    ).not.toBeNull();
    expect(rosterParent().querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(mixed.sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(mixed.sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(1);

    const navigation = vi.fn();
    mixed.sidebar.onNavigate = navigation;
    mixed.sidebar
      .querySelector<HTMLAnchorElement>(`[data-session-key="${persistentKey}"] a`)!
      .click();
    expect(navigation).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/main/dashboard/implementation" }),
    );

    mixed.result.ts += 1;
    mixed.result.sessions = [
      rosterRows[0]!,
      { ...failedRun, agentId: "main", unread: true },
      rosterRows[2]!,
    ];
    mixed.sessions.publishList({ result: mixed.result });
    await waitForFast(() =>
      expect(rosterParent().querySelector('[data-session-attention="error"]')).not.toBeNull(),
    );
    expect(rosterParent().querySelector(".session-glyph__ring")).toBeNull();
    expect(rosterParent().querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(rosterParent().textContent).toContain(
      "Child session Review changes failed: Review failed",
    );
    expect(mixed.sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(mixed.sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(1);
  });

  it.each(["plain", "icon", "owner"])(
    "rings an idle %s parent until its hidden child finishes",
    async (appearance) => {
      const parentKey = "agent:main:idle-parent";
      const sessions = createSessionsHarness("main", [parentKey]);
      const row = sessions.sessions.state.result!.sessions[0]!;
      row.hasActiveRun = false;
      row.hasActiveSubagentRun = true;
      row.status = "done";
      row.unread = true;
      if (appearance === "icon") {
        row.icon = "braces";
      } else if (appearance === "owner") {
        row.owner = { actor: { type: "human", id: "ada", label: "Ada" } };
      }
      row.childSessions = ["agent:main:subagent:idle-parent-child"];
      const { sidebar } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        sessions.sessions,
      );
      const parent = sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
      expect(
        parent.querySelector('.session-glyph__ring[aria-label="Subagents working"]'),
      ).not.toBeNull();
      expect(parent.classList.contains("session-row-host--running")).toBe(true);
      expect(parent.querySelector(".session-unread-dot, .session-glyph__badge--unread")).toBeNull();
      expect(parent.querySelector("[data-child-session-toggle]")).toBeNull();
      sessions.publish({
        result: reconcileSessionChanged(sessions.sessions.state.result, {
          sessionKey: parentKey,
          hasActiveSubagentRun: false,
        }).result,
      });
      await sidebar.updateComplete;
      const finished = sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
      expect(finished.querySelector(".session-glyph__ring")).toBeNull();
      expect(finished.classList.contains("session-row-host--running")).toBe(false);
      expect(
        finished.querySelector(".session-unread-dot, .session-glyph__badge--unread"),
      ).not.toBeNull();
    },
  );

  it("rings a queued parent and its idle child while a grandchild works", async () => {
    const parentKey = "agent:main:queued-parent";
    const childKey = "agent:main:delegating-child";
    const sessions = createSessionsHarness("main", [parentKey]);
    const result = sessions.sessions.state.result!;
    Object.assign(result.sessions[0]!, {
      hasActiveRun: true,
      status: "queued",
      childSessions: [childKey],
    });
    sessions.list.mockResolvedValue({
      ...result,
      sessions: [
        {
          key: childKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Delegating child",
          updatedAt: 2,
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
    const { sidebar } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      sessions.sessions,
    );
    sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)!.click();
    await waitForFast(() => {
      for (const key of [parentKey, childKey]) {
        const row = sidebar.querySelector(`[data-session-key="${key}"]`)!;
        expect(
          row?.querySelector('.session-glyph__ring[aria-label="Subagents working"]'),
        ).not.toBeNull();
        expect(row?.querySelector(".session-glyph__ring--queued")).toBeNull();
      }
    });
    sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)!.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${parentKey}"] .session-glyph__ring`),
    ).not.toBeNull();
  });
});
