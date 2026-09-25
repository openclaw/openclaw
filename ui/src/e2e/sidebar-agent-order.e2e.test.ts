import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Manual team-sidebar agent order" });
const imageAvatar =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Engineering" },
    { id: "research", name: "Research", identity: { emoji: "🔬" } },
    { id: "writing", name: "Writing", identity: { avatarUrl: imageAvatar } },
  ],
};
const sessionRow = (
  id: string,
  label: string,
  extra: Partial<GatewaySessionRow & { updatedAt: number }> = {},
): GatewaySessionRow & { updatedAt: number } => ({
  key: `agent:main:${id}`,
  kind: "direct",
  agentId: "main",
  label,
  updatedAt: 100,
  ...extra,
});
const sessionRows = [
  sessionRow("project", "Project next steps"),
  sessionRow("weekly", "Weekly review"),
  sessionRow("parent", "Implement the navigation sidebar without losing independent outcomes", {
    lastMessagePreview: "A preview must not create a second line in team mode.",
  }),
  sessionRow("child", "Check rendering", { spawnedBy: "agent:main:parent" }),
  sessionRow("grandchild", "Compare deeply nested layouts with long labels", {
    spawnedBy: "agent:main:child",
    hasActiveRun: true,
    status: "running",
    unread: true,
    startedAt: Date.now() - 3_000,
  }),
  sessionRow("failure", "Review failed checks", {
    spawnedBy: "agent:main:parent",
    status: "failed",
    endedAt: 100,
    lastRunError: "Geometry mismatch",
  }),
  sessionRow("queued", "Queued follow-up", { hasActiveRun: true, status: "queued" }),
  sessionRow("private", "Private planning", { incognito: true }),
  sessionRow("automation", "Daily review", { hasAutomation: true }),
];
const sessions: SessionsListResult = {
  ts: 100,
  path: "",
  count: sessionRows.length,
  defaults: { model: null, modelProvider: null, contextTokens: null },
  sessions: sessionRows,
};

suite.define(() => {
  it("reorders with the keyboard and drag, persists across reload and resets", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await page.addInitScript(
        ({ storageKey }) => {
          if (localStorage.getItem(storageKey)) {
            return;
          }
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              sidebarAgentsMode: "roster",
              navWidth: 334,
              theme: "claw",
              themeMode: "light",
            }),
          );
        },
        { storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
      );
      await installMockGateway(page, {
        sessions: sessionRows,
        methodResponses: {
          "agents.list": agentsList,
          "agents.overview": {
            agents: agentsList.agents.map((agent) => ({
              ...agent,
              counts: {
                sessions: sessions.sessions.filter((row) => row.agentId === agent.id).length,
              },
            })),
          },
          "chat.startup": {
            agentsList,
            messages: [],
            metadata: { models: [] },
            sessionKey: "agent:main:main",
            thinkingLevel: null,
          },
          "sessions.list": sessions,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiRoute(page, { routeId: "chat" });
      const sidebar = page.locator("openclaw-app-sidebar");
      const groups = sidebar.locator("section[data-agent-group]");
      await groups.first().waitFor();
      const order = () =>
        groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-group")));
      await expect.poll(order).toEqual(["main", "research", "writing"]);
      await captureSidebarUiProof(suite, page, "agent-order-before.png");
      const research = sidebar.locator('[data-agent-group="research"]');
      await research.getByRole("button", { name: "Options for Research" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move agent up", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(order).toEqual(["research", "main", "writing"]);
      await expect
        .poll(() =>
          research
            .getByRole("button", { name: "Options for Research" })
            .evaluate((node) => node === document.activeElement),
        )
        .toBe(true);
      await captureSidebarUiProof(suite, page, "agent-order-after.png");
      await sidebar.locator(".sidebar-brand__new-thread").click();
      const newMenu = sidebar.locator(".sidebar-brand .sidebar-new-session-menu");
      await expect.poll(() => newMenu.locator("wa-dropdown-item").first().isVisible()).toBe(true);
      await expect
        .poll(() =>
          newMenu
            .locator("wa-dropdown-item[value]")
            .evaluateAll((items) => items.map((item) => item.getAttribute("value"))),
        )
        .toEqual(["research", "main", "writing"]);
      await page.keyboard.press("Escape");
      await page.reload();
      await waitForControlUiRoute(page, { routeId: "chat" });
      await expect.poll(order).toEqual(["research", "main", "writing"]);
      const researchHeader = research.locator(".sidebar-recent-sessions__head");
      const mainHeader = sidebar.locator(
        '[data-agent-group="main"] .sidebar-recent-sessions__head',
      );
      await researchHeader.dragTo(mainHeader, {
        // Start in the gap after the collapse button; controls intentionally cannot start a drag.
        sourcePosition: { x: 22, y: 24 },
        // The lower half inserts after Main, reversing the keyboard move above.
        targetPosition: { x: 8, y: 40 },
      });
      await expect.poll(order).toEqual(["main", "research", "writing"]);
      await research.getByRole("button", { name: "Options for Research" }).click();
      await page.getByRole("menuitem", { name: "Reset agent order", exact: true }).click();
      await expect.poll(order).toEqual(["main", "research", "writing"]);
    });
  });
});
