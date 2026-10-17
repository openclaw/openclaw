import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectFocused, pressAndExpectFocus } from "./sidebar-assertions.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
    { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
  ],
};
const rows: Array<GatewaySessionRow & ControlUiSessionFixture> = agentsList.agents.flatMap(
  (agent) => [
    {
      key: `agent:${agent.id}:main`,
      agentId: agent.id,
      kind: "direct",
      isMain: true,
      updatedAt: 100,
      lastAssistantMessage: {
        text: `${agent.name} is ready for the next task.`,
        timestamp: 100,
      },
    },
    {
      key: `agent:${agent.id}:project`,
      agentId: agent.id,
      kind: "direct",
      updatedAt: 99,
      hasActiveRun: agent.id === "forge",
      status: agent.id === "forge" ? "running" : "done",
      unread: agent.id === "scout",
    },
  ],
);
const sessions: SessionsListResult = {
  ts: 100,
  path: "",
  count: rows.length,
  defaults: { model: null, modelProvider: null, contextTokens: null },
  sessions: rows,
};

suite.define(() => {
  it("shows all sessions from the selector while preserving agent rows, shortcuts, and scoped Sessions", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarAgentsMode: "chip",
                railShortcuts: ["session:agent:forge:project"],
              }),
            );
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const gateway = await installMockGateway(page, {
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
                  avatar: "",
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
        await sidebar.locator(".sidebar-agent-card__main").click();
        const selector = sidebar.locator(".sidebar-agent-menu");
        const allAgents = selector.locator('[data-value="scope:all"]');
        await expectFocused(selector.locator('[data-value="agent:main"]'));
        expect(
          await selector
            .locator('[role^="menuitem"]')
            .evaluateAll((items) => items.map((item) => item.getAttribute("data-value"))),
        ).toEqual(["command:new-agent", "scope:all", "agent:main", "agent:forge", "agent:scout"]);
        await pressAndExpectFocus(
          page,
          "Home",
          selector.locator('[data-value="command:new-agent"]'),
        );
        await pressAndExpectFocus(page, "ArrowDown", allAgents);
        await page.keyboard.press("Enter");
        const expectAllSessions = async () => {
          await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
          await expect
            .poll(() =>
              page
                .locator(".sessions-table .session-agent-col [data-agent-id]")
                .evaluateAll((chips) =>
                  chips
                    .map((chip) => chip.getAttribute("data-agent-id") ?? "")
                    .toSorted((left, right) => left.localeCompare(right)),
                ),
            )
            .toEqual(["forge", "forge", "main", "main", "scout", "scout"]);
          expect((await gateway.getRequests("sessions.list")).at(-1)?.params).not.toHaveProperty(
            "agentId",
          );
        };
        await expectAllSessions();
        const headers = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => headers.count()).toBe(3);
        expect(
          await headers.evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-agent-id")),
          ),
        ).toEqual(["main", "forge", "scout"]);
        expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(0);
        expect(await sidebar.locator("[data-agent-collapse]").count()).toBe(0);
        expect(
          await sidebar.locator(".sidebar-agent-roster__signals .session-unread-dot").count(),
        ).toBe(0);
        expect(
          await sidebar
            .locator(
              '[data-agent-group="forge"] .sidebar-agent-roster__avatar .session-glyph--running',
            )
            .count(),
        ).toBe(1);
        expect(
          await sidebar
            .locator('.sidebar-rail [data-sidebar-entry="session:agent:forge:project"]')
            .count(),
        ).toBe(1);
        await captureSidebarUiProof(suite, page, "sidebar-agent-only-roster.png");

        const forge = sidebar.locator('[data-agent-group="forge"]');
        await forge.locator(".sidebar-agent-roster__avatar").click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge" });
        const menu = forge.locator(".sidebar-agent-roster__menu");
        await menu.getByRole("button", { name: "Options for Forge" }).click();
        expect(await menu.locator('[role^="menuitem"]').allTextContents()).toEqual([
          expect.stringContaining("Pin"),
          expect.stringContaining("Sessions"),
          expect.stringContaining("Settings"),
          expect.stringContaining("Delete"),
        ]);
        expect(await menu.getByRole("menuitem", { name: "Create new session" }).count()).toBe(0);
        await menu.getByRole("menuitem", { name: "Sessions" }).click();
        await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).some(
              (request) => (request.params as { agentId?: string })?.agentId === "forge",
            ),
          )
          .toBe(true);

        const workspace = sidebar.locator(".sidebar-workspace-header__main");
        await page.mouse.move(1100, 700);
        await workspace.focus();
        await workspace.hover();
        await expect.poll(() => selector.getAttribute("data-phase")).toBe("open");
        await expectFocused(workspace);
        await page.keyboard.press("Enter");
        await expectFocused(allAgents);
        await pressAndExpectFocus(page, "End", selector.locator('[data-value="agent:scout"]'));
        await pressAndExpectFocus(
          page,
          "Home",
          selector.locator('[data-value="command:new-agent"]'),
        );
        await pressAndExpectFocus(page, "ArrowDown", allAgents);
        await page.keyboard.press("Enter");
        await expectAllSessions();
      },
    );
  });

  it.each([false, true])(
    "keeps the run ring on the avatar and session metadata out of mobile agent rows (touch=%s)",
    async (touch) => {
      await suite.withPage(
        { viewport: { width: 390, height: 900 }, hasTouch: touch, isMobile: touch },
        async ({ page }) => {
          await page.addInitScript(
            ({ key }) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" })),
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
          );
          await installMockGateway(page, {
            sessions: rows,
            methodResponses: {
              "agents.list": agentsList,
              "sessions.list": sessions,
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await waitForControlUiRoute(page, { routeId: "chat" });
          const drawer = page
            .locator(".topbar-nav-toggle:visible,.chat-pane__nav-toggle:visible")
            .first();
          if ((await drawer.getAttribute("aria-expanded")) === "false") {
            await drawer.click();
          }
          const sidebar = page.locator("openclaw-app-sidebar");
          const forge = sidebar.locator('[data-agent-group="forge"]');
          await forge.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              forge.locator(".sidebar-agent-roster__avatar .session-glyph--running").count(),
            )
            .toBe(1);
          expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(0);
          expect(await sidebar.locator("[data-agent-collapse]").count()).toBe(0);
          expect(
            await forge
              .locator(".session-unread-dot, .session-row-badge, .session-owner-chip")
              .count(),
          ).toBe(0);
          expect(
            await forge.locator(".sidebar-agent-roster__signals .session-glyph__ring").count(),
          ).toBe(0);
          await captureSidebarUiProof(suite, page, `sidebar-agent-only-mobile-${touch}.png`);
        },
      );
    },
  );
});
