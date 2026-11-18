import { expect, it } from "vitest";
import { patchSettings } from "../app/settings.ts";
import {
  mountRoster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

for (const mode of ["chip", "roster"] as const) {
  it(`keeps self-parented Home navigable with child discovery in ${mode} mode`, async () => {
    const key = "agent:main:main";
    const { sidebar, context } = await mountRoster(undefined, [
      {
        key,
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        updatedAt: 1,
        childSessions: ["agent:main:child", "agent:main:subagent:review"],
        label: "Home",
        lastMessagePreview: "Home context",
      },
      {
        key: "agent:main:child",
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        spawnedBy: key,
        updatedAt: 2,
        label: "Child conversation",
      },
      {
        key: "agent:main:subagent:review",
        agentId: "main",
        kind: "direct",
        spawnedBy: key,
        updatedAt: 3,
        hasActiveRun: true,
        label: "Review worker",
      },
    ]);
    patchSettings({ sidebarAgentsMode: mode });
    await settleRoster(sidebar);
    const home = sidebar.projectHomeSession(sidebar.mainSessionRow()!, "main");
    expect(home.key).toBe(key);
    expect(home.subagentSummary?.runningChildCount).toBe(1);
    expect(home.childLoadParentKeys).toContain(key);
    expect(home.children?.map((row) => row.key)).toContain("agent:main:child");
    if (mode === "chip") {
      expect(sidebar.querySelector('[data-session-key="agent:main:child"]')?.textContent).toContain(
        "Child conversation",
      );
    } else {
      expect(sidebar.querySelector('[data-session-key="agent:main:child"]')).toBeNull();
      expect(
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__row'),
      ).not.toBeNull();
    }
    sidebar
      .querySelector<HTMLButtonElement>(
        ".sidebar-agent-card__main, .sidebar-workspace-header__main",
      )!
      .click();
    await settleRoster(sidebar);
    sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:recent"]')!.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state).toEqual({ selectedId: "recent", scopeId: "recent" });
    expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain("Scout");
  });
}

it("keeps agent switching available without a Home session", async () => {
  const { sidebar, context } = await mountRoster(undefined, []);
  expect(sidebar.mainSessionRow()).toBeNull();
  sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
  await settleRoster(sidebar);
  sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:recent"]')!.click();
  await settleRoster(sidebar);
  expect(context.agentSelection.state).toEqual({ selectedId: "recent", scopeId: "recent" });
  expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain("Scout");
});
