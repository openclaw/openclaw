import { expect, it } from "vitest";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
suite.define(() => {
  it("captures synthetic team categories without a live Gateway", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      const agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Harbor" },
          { id: "scout", name: "Scout" },
        ],
      };
      const sessions = agentsList.agents.flatMap((agent, index) => [
        {
          key: "agent:" + agent.id + ":main",
          agentId: agent.id,
          isMain: true,
          kind: "direct",
          updatedAt: Date.now(),
          label: agent.name,
        },
        ...["Planning", "Development"].map((category, n) => ({
          key: "agent:" + agent.id + ":" + n,
          agentId: agent.id,
          isMain: false,
          kind: "direct",
          category,
          label: category === "Planning" ? "Plan next milestone" : "Review interface changes",
          updatedAt: Date.now() - (index + n + 1) * 1000,
        })),
        {
          key: "agent:" + agent.id + ":pin",
          agentId: agent.id,
          isMain: false,
          kind: "direct",
          category: "Planning",
          pinned: true,
          label: "Pinned project notes",
          updatedAt: Date.now() - 5000,
        },
        {
          key: "agent:" + agent.id + ":other",
          agentId: agent.id,
          isMain: false,
          kind: "direct",
          label: "Quick question",
          updatedAt: Date.now() - 6000,
        },
      ]);
      await page.addInitScript(() => {
        localStorage.setItem(
          "openclaw.control.settings.v1",
          JSON.stringify({
            gatewayUrl: "ws://127.0.0.1:18789",
            showOnboarding: false,
            sidebarAgentsMode: "roster",
            sessionsGrouping: "none",
          }),
        );
      });
      await installMockGateway(page, {
        sessions,
        methodResponses: {
          "agents.list": agentsList,
          "chat.startup": {
            agentsList,
            sessionKey: "agent:main:main",
            sessionId: "main",
            messages: [],
          },
          "sessions.groups.list": { groups: ["Planning", "Development", "Empty category"] },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-agent-card__main").click();
      await sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();
      await sidebar.locator('[data-agent-group="scout"]').waitFor({ timeout: 15000 });
      await expect
        .poll(() => sidebar.locator('[data-session-key="agent:scout:0"]').count())
        .toBe(1);
      if (process.env.OPENCLAW_TEAM_CATEGORIES_BEFORE !== "1") {
        await expect
          .poll(() =>
            sidebar.locator('[data-session-section="agent:scout:category:Planning"]').count(),
          )
          .toBe(1);
        expect(await sidebar.locator(".sidebar-session-group-actions").count()).toBe(0);
      }
      await captureUiProof(
        suite,
        page,
        process.env.OPENCLAW_TEAM_CATEGORIES_BEFORE === "1"
          ? "team-categories-before.png"
          : "team-categories-after.png",
      );
    } finally {
      await context.close();
    }
  });
});
