import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Agent-first sidebar geometry" });
const imageAvatar =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGN4nhWCFTEQkPj64w8ag5AEPqPgiDgdmAgA9YRzYZfFh50AAAAASUVORK5CYII=";
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Engineering" },
    { id: "research", name: "Research and competitive intelligence", identity: { emoji: "🔬" } },
    { id: "writing", name: "Writing", identity: { avatarUrl: imageAvatar } },
  ],
};
const rows: Array<GatewaySessionRow & ControlUiSessionFixture> = [
  {
    key: "agent:main:project",
    agentId: "main",
    kind: "direct",
    updatedAt: 100,
    lastAssistantMessage: {
      text: "I've set up the template, but it still needs a final review before sharing with the team.",
      timestamp: 90,
    },
  },
  {
    key: "agent:main:working",
    agentId: "main",
    kind: "direct",
    updatedAt: 99,
    hasActiveRun: true,
    status: "running",
  },
  {
    key: "agent:main:failure",
    agentId: "main",
    kind: "direct",
    updatedAt: 98,
    status: "failed",
    lastRunError: "Geometry mismatch",
  },
];
const sessions: SessionsListResult = {
  ts: 100,
  path: "",
  count: rows.length,
  defaults: { model: null, modelProvider: null, contextTokens: null },
  sessions: rows,
};

suite.define(() => {
  it.each([
    { mode: "light", width: 258, touch: false },
    { mode: "light", width: 334, touch: false },
    { mode: "dark", width: 286, touch: false },
    { mode: "light", width: 334, touch: true },
  ] as const)(
    "keeps agent-only rows readable in $mode at $width px (touch=$touch)",
    async ({ mode, width, touch }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
          colorScheme: mode,
          hasTouch: touch,
        },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, prefs }) => {
              localStorage.setItem(key, JSON.stringify(prefs));
              localStorage.setItem(
                "openclaw:control-ui:community-invite:v2",
                JSON.stringify({ dismissedAtMs: Date.now() }),
              );
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              prefs: { sidebarAgentsMode: "roster", navWidth: width, themeMode: mode },
            },
          );
          await installMockGateway(page, {
            sessions: rows,
            methodResponses: {
              "agents.list": agentsList,
              "agent.identity.get": {
                cases: agentsList.agents.map((agent) => ({
                  match: { agentId: agent.id },
                  response: {
                    agentId: agent.id,
                    name: agent.name,
                    emoji: agent.identity?.emoji,
                    avatar: agent.identity?.avatarUrl ?? "",
                  },
                })),
              },
              "chat.startup": {
                agentsList,
                messages: [],
                metadata: { models: [] },
                sessionId: "main-session",
                thinkingLevel: null,
              },
              "sessions.list": sessions,
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiRoute(page, { routeId: "chat" });

          const sidebar = page.locator("openclaw-app-sidebar");
          const main = sidebar.locator('[data-agent-group="main"]');
          const row = main.locator(".sidebar-agent-roster__row");
          await main.waitFor({ state: "visible" });
          expect(await sidebar.locator(".sidebar-agent-roster__group").count()).toBe(3);
          expect(await sidebar.locator("[data-agent-collapse]").count()).toBe(0);
          expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(0);
          expect(
            await page.locator(".shell-nav").evaluate((el) => el.getBoundingClientRect().width),
          ).toBe(width + 52);

          await expect
            .poll(() => main.locator(".sidebar-agent-roster__preview").textContent())
            .toContain("I've set up the template");
          expect(
            await main.locator(".sidebar-agent-roster__avatar .session-glyph--running").count(),
          ).toBe(1);
          expect(
            await main.locator(".sidebar-agent-roster__signals .session-glyph__ring").count(),
          ).toBe(0);
          expect(
            await main
              .locator('.sidebar-agent-roster__signals [data-session-attention="error"]')
              .count(),
          ).toBe(1);
          expect(
            await sidebar
              .locator('[data-agent-group="research"] .sidebar-agent-roster__avatar [data-avatar]')
              .getAttribute("data-avatar"),
          ).toContain("🔬");
          expect(
            await sidebar
              .locator('[data-agent-group="writing"] .sidebar-agent-roster__avatar img')
              .getAttribute("src"),
          ).toBe(imageAvatar);

          const restingPadding = await row.evaluate((el) => getComputedStyle(el).paddingRight);
          expect(restingPadding).toBe(touch ? "32px" : "0px");
          if (!touch) {
            await main.locator(".sidebar-agent-roster__header").hover();
            expect(await row.evaluate((el) => getComputedStyle(el).paddingRight)).toBe("32px");
          }
          const header = await main.locator(".sidebar-agent-roster__header").boundingBox();
          const actions = await main.locator(".sidebar-agent-roster__actions").boundingBox();
          expect(header).not.toBeNull();
          expect(actions).not.toBeNull();
          expect(actions!.x + actions!.width).toBeLessThanOrEqual(header!.x + header!.width);
          await captureSidebarUiProof(suite, page, `agent-only-${mode}-${width}-${touch}.png`);
        },
      );
    },
  );
});
