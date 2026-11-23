import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  openSelectedAgentRowMenu,
  selectedAgentRow,
  showAllSidebarAgents,
  showOnlySidebarAgent,
} from "./sidebar-agent-row.test-support.ts";
import {
  expectPath,
  catalogList,
  mockRequests,
  expectText,
  expectFocused,
  pressAndExpectFocus,
} from "./sidebar-assertions.test-support.ts";
import {
  createSidebarCustomizationSuite,
  openSidebarCustomizationPage,
  openSidebarPinMenu,
} from "./sidebar-customization.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar interactions mocked Gateway E2E");
const desktop = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1440 },
};
const pixelAvatar =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function agentResponses(agents: Array<{ id: string; name?: string }>) {
  const agentsList = { agents, defaultId: "main", mainKey: "main", scope: "agent" };
  return {
    "agents.list": agentsList,
    "chat.startup": {
      agentsList,
      messages: [],
      metadata: { models: [] },
      sessionId: "session:agent:main:main",
      thinkingLevel: null,
    },
  };
}

suite.define(() => {
  it("keeps every new-session plus native and opens group and catalog targets without creating sessions", async () => {
    await suite.withPage(desktop, async ({ context, page }) => {
      const agentId = "research";
      const group = "Client & ops / α";
      const catalogId = "cli-tools";
      const basePath = "/operator";
      const scenario: ControlUiMockGatewayScenario = {
        basePath,
        defaultAgentId: agentId,
        sessionKey: `agent:${agentId}:main`,
        sessionGroups: [group],
        sessions: [
          { key: `agent:${agentId}:main`, label: "Main" },
          { key: `agent:${agentId}:client-ops`, label: "Grouped conversation", category: group },
          { key: `agent:${agentId}:notes`, label: "Ungrouped notes" },
        ],
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        methodResponses: {
          "sessions.catalog.list": catalogList({
            id: catalogId,
            label: "CLI tools",
            host: "Gateway Mac",
            thread: "cli-thread",
            name: "CLI plan",
            status: "stored",
            archive: false,
            startTerminal: true,
          }),
        },
      };
      // The opener and real browser-created tabs must receive the same Gateway fixture.
      await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) }),
      );
      await context.addInitScript({ content: createControlUiMockGatewayInitScript(scenario) });

      await page.goto(
        controlUiSessionUrl(`${suite.server.baseUrl}operator/`, `agent:${agentId}:main`),
      );
      await waitForControlUiRoute(page, { routeId: "chat" });
      await chooseSidebarMenuOption(page, "Status", "All");
      await closeSidebarMenu(page);
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      const draft = "Keep this unsent conversation draft";
      await composer.fill(draft);
      const originalUrl = page.url();
      const headerAction = {
        selector: ".sidebar-session-toolbar .sidebar-new-session",
        params: { agent: agentId },
      };
      const sectionAction = (section: string, params: Record<string, string> = {}) => ({
        selector: `[data-session-section="${section}"] .sidebar-new-session`,
        section,
        params: { agent: agentId, ...params },
      });
      const actions: Array<{
        selector: string;
        section?: string;
        params: Record<string, string>;
        newTab?: "middle" | "modified";
      }> = [
        headerAction,
        { ...sectionAction(`category:${group}`, { group }), newTab: "middle" },
        sectionAction("ungrouped"),
        {
          selector: `[data-session-section="catalog:${catalogId}"] .sidebar-session-catalog-new`,
          section: `catalog:${catalogId}`,
          params: { agent: agentId, catalog: catalogId },
          newTab: "modified",
        },
      ];
      // The header action closes with its panel, so every action runs with Sessions open.
      for (const [index, action] of actions.entries()) {
        if (action.section) {
          await page
            .locator(`[data-session-section="${action.section}"] .sidebar-recent-sessions__head`)
            .hover();
        }
        const link = page.locator(action.selector);
        await link.hover();
        if (index === 0) {
          // Exercise the neighboring header with the shortcut hint already open.
          await expect
            .poll(() =>
              link.evaluate(
                (element) => element.closest("openclaw-tooltip")?.hasAttribute("open") ?? false,
              ),
            )
            .toBe(true);
        }
        const expectedUrl = new URL(`${basePath}/new`, suite.server.baseUrl);
        expectedUrl.search = new URLSearchParams(action.params).toString();
        expect(await link.getAttribute("href")).toBe(
          `${expectedUrl.pathname}${expectedUrl.search}`,
        );
        expect(
          await link.evaluate((element) => {
            const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            (element.querySelector("svg") ?? element).dispatchEvent(event);
            return event.defaultPrevented;
          }),
        ).toBe(false);

        if (!action.newTab) {
          continue;
        }

        // Native tab gestures do not retain an opener, so observe the browser context.
        const [popup] = await Promise.all([
          context.waitForEvent("page"),
          action.newTab === "modified"
            ? link.click({ modifiers: ["ControlOrMeta"] })
            : link.click({ button: "middle" }),
        ]);
        try {
          await waitForControlUiRoute(popup, {
            routeId: "new-session",
            pathname: expectedUrl.pathname,
            search: expectedUrl.search,
          });
          await popup.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(popup.url()).toBe(expectedUrl.href);
          expect(await mockRequests(popup, "sessions.create")).toEqual([]);
          expect(page.url()).toBe(originalUrl);
          expect(await composer.inputValue()).toBe(draft);
          expect(await mockRequests(page, "sessions.create")).toEqual([]);
        } finally {
          await popup.close();
        }
      }

      await page.locator(".sidebar-session-toolbar .sidebar-new-session").click();
      await waitForControlUiRoute(page, {
        routeId: "new-session",
        pathname: `${basePath}/new`,
        search: `?agent=${agentId}`,
      });
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(context.pages()).toHaveLength(1);
      expect(await mockRequests(page, "sessions.create")).toEqual([]);
    });
  });

  it.each(["Escape", "Tab"] as const)("returns pin-menu focus on %s", async (exit) => {
    const { context, page } = await openSidebarCustomizationPage(suite);
    try {
      const menu = await openSidebarPinMenu(page);
      const items = menu.getByRole("menuitem");
      if (exit === "Tab") {
        expect((await items.allTextContents()).map((text) => text.trim())).toEqual([
          "Move up",
          "Move down",
          "Unpin",
        ]);
      }
      await expectFocused(items.first(), true);
      const steps: Array<[string, number]> =
        exit === "Escape"
          ? [
              ["End", -1],
              ["Home", 0],
            ]
          : [
              ["ArrowDown", 1],
              ["End", -1],
              ["ArrowDown", 0],
            ];
      for (const [key, index] of steps) {
        await pressAndExpectFocus(page, key, items.nth(index), true);
      }
      await page.keyboard.press(exit);
      await menu.waitFor({ state: "detached" });
      const target =
        exit === "Escape"
          ? page
              .locator('[data-sidebar-entry="route:dashboards"]')
              .getByRole("link", { name: "Dashboards", exact: true })
          : page.locator('.sidebar-rail [data-sidebar-entry="route:systems"] .nav-item');
      await expectFocused(target);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("opens settings from the agent row and switches agents through Show all", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "agent.identity.get": {
            cases: [
              { agentId: "main", avatar: "", emoji: "🦞", name: "Scheduled Automations" },
              { agentId: "research", avatar: pixelAvatar, name: "Research" },
              { agentId: "forge", avatar: "", emoji: "🔧", name: "Forge" },
              { agentId: "support", avatar: "", emoji: "🧭", name: "Support" },
            ].map((response) => ({ match: { agentId: response.agentId }, response })),
          },
          ...agentResponses([
            { id: "main" },
            { id: "research" },
            { id: "forge" },
            { id: "support" },
          ]),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      const draft = "Keep this draft while opening agent settings";
      await composer.fill(draft);
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = await openSelectedAgentRowMenu(sidebar);
      const items = row.locator('[role="menu"] [role^="menuitem"]');
      await expect
        .poll(() => items.evaluateAll((entries) => entries.map((item) => item.dataset.value)))
        .toEqual(["show-all", "new-agent", "pin", "sessions", "settings", "delete"]);
      await row.locator('[role="menu"] [data-value="settings"]').click();
      await waitForControlUiRoute(page, { routeId: "agents", pathname: "/settings/agents/main" });
      await page.locator(".settings-sidebar__back").click();
      await waitForControlUiRoute(page, { routeId: "chat" });
      expect(await composer.inputValue()).toBe(draft);
      await showOnlySidebarAgent(sidebar, "research");
      await expectPath(page, controlUiSessionPath("agent:research:main"));
      const selected = selectedAgentRow(sidebar);
      await expectText(selected.locator(".sidebar-agent-roster__name"), "Research");
      const image = selected.locator(".sidebar-agent-roster__avatar img");
      await expect.poll(() => image.getAttribute("src")).toBe(pixelAvatar);
    });
  });

  it("shares the selected agent from its row menu by asking in its main session", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "templates.drafts.create"],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "agent-share",
            valid: true,
            issues: [],
          },
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "research", name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await showOnlySidebarAgent(sidebar, "research");
      const research = await openSelectedAgentRowMenu(sidebar);
      await research
        .locator('[role="menu"]')
        .getByRole("menuitem", { name: "Share Research", exact: true })
        .click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({
        sessionKey: "agent:research:main",
        message: "Create a shareable template of yourself",
      });
      await expectPath(page, controlUiSessionPath("agent:research:main"));
      // The mocked Gateway does not echo sends into an already open transcript.
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests("templates.drafts.create")).toHaveLength(0);
    });
  });

  it("keeps the agent row menu inside a short viewport beside a crowded roster", async () => {
    await suite.withPage(
      { ...desktop, viewport: { width: 1440, height: 480 } },
      async ({ page }) => {
        const agents = Array.from({ length: 40 }, (_, index) => ({
          id: index === 0 ? "main" : `agent-${index}`,
          name:
            index === 1 || index === 2 ? "Support" : `Research and documentation agent ${index}`,
        }));
        await installMockGateway(page, {
          methodResponses: {
            ...agentResponses(agents),
            "agent.identity.get": {
              cases: agents.map(({ id, name }) => ({
                match: { agentId: id },
                response: { agentId: id, name },
              })),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = await openSelectedAgentRowMenu(sidebar);
        const menu = row.locator('[role="menu"]');
        expect(
          await menu.evaluate((surface) =>
            [...surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')].every((action) => {
              const box = action.getBoundingClientRect();
              return box.top >= 0 && box.bottom <= innerHeight;
            }),
          ),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await showAllSidebarAgents(sidebar);
        // Agents that share a name stay separate rows, without exposing their ids.
        expect(await sidebar.locator('[data-agent-group][aria-label="Support"]').count()).toBe(2);
      },
    );
  });
});
