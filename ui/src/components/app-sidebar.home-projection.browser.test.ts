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

it("only shows a child disclosure on pins that can expand a sidebar branch", async () => {
  const main = "agent:main:main";
  const homeChild = "agent:main:home-child";
  const parent = "agent:main:project";
  const projectChild = "agent:main:project-child";
  const { sidebar } = await mountRoster(undefined, [
    {
      key: main,
      agentId: "main",
      kind: "direct",
      label: "Main session",
      childSessions: [homeChild],
    },
    {
      key: homeChild,
      agentId: "main",
      kind: "direct",
      label: "Release notes",
      spawnedBy: main,
    },
    {
      key: parent,
      agentId: "main",
      kind: "direct",
      label: "Design review",
      childSessions: [projectChild],
    },
    {
      key: projectChild,
      agentId: "main",
      kind: "direct",
      label: "Review screenshots",
      spawnedBy: parent,
    },
  ]);
  patchSettings({ sidebarAgentsMode: "chip" });
  sidebar.sidebarEntries = [main, parent].map((key) => `session:${key}`);
  await settleRoster(sidebar);

  const pins = sidebar.querySelector(".sidebar-recent-sessions--pinned")!;
  const disclosure = (key: string) =>
    pins.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${key}"]`);
  expect(pins.querySelector(`[data-session-key="${main}"] a`)?.textContent).toContain(
    "Main session",
  );
  expect(sidebar.querySelector(`[data-session-key="${homeChild}"]`)?.textContent).toContain(
    "Release notes",
  );
  expect(disclosure(main)).toBeNull();

  const toggle = disclosure(parent)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  await settleRoster(sidebar);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(pins.querySelector(`[data-session-key="${projectChild}"]`)?.textContent).toContain(
    "Review screenshots",
  );
});

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
