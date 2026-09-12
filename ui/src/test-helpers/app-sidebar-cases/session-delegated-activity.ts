import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { reconcileSessionChanged } from "../../lib/sessions/reconcile.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

describe("AppSidebar delegated activity", () => {
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
      row.childSessions = ["agent:main:idle-parent-child"];
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
      expect(parent.querySelector(".sidebar-child-session-toggle--running")).not.toBeNull();
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
          childSessions: ["agent:main:grandchild"],
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
