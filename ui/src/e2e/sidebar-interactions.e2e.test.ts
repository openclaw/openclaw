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
  expectPath,
  catalogList,
  mockRequests,
  expectText,
  expectAttribute,
  expectCount,
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
      const railAction = {
        selector: ".sidebar-rail .sidebar-new-session",
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
        railAction,
        { ...sectionAction(`category:${group}`, { group }), newTab: "middle" },
        sectionAction("ungrouped"),
        {
          selector: `[data-session-section="catalog:${catalogId}"] .sidebar-session-catalog-new`,
          section: `catalog:${catalogId}`,
          params: { agent: agentId, catalog: catalogId },
          newTab: "modified",
        },
        railAction,
      ];
      for (const [index, action] of actions.entries()) {
        if (index === actions.length - 1) {
          await page.locator('[data-navigation-view][aria-pressed="true"]').click();
        }
        if (action.section) {
          // Leave the previous control so its tooltip cannot cover the next header.
          await composer.hover();
          await page
            .locator(`[data-session-section="${action.section}"] .sidebar-recent-sessions__head`)
            .hover();
        }
        const link = page.locator(action.selector);
        await link.hover();
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

      await page.locator(".sidebar-rail .sidebar-new-session").click();
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
          : page.locator('[data-sidebar-entry="route:systems"] .nav-item');
      await expectFocused(target);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows one row per agent plus Show all and reaches them with menu keys", async () => {
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
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      const menu = sidebar.locator(".sidebar-agent-menu");
      const mainSwitch = menu.getByRole("menuitem", { name: "Scheduled Automations", exact: true });
      const researchSwitch = menu.getByRole("menuitem", { name: "Research", exact: true });
      await expect
        .poll(() =>
          menu
            .locator(".sidebar-agent-menu__agent-list .agent-select__option-label")
            .allTextContents(),
        )
        .toEqual(["Show all", "Scheduled Automations", "Research", "Forge", "Support"]);
      await expect
        .poll(() => researchSwitch.locator(".agent-select__avatar img").getAttribute("src"))
        .toContain("data:image/png;base64,");
      await expectCount(menu.getByText(/^New session —/), 0);
      await menu.evaluate(async (dropdown) => {
        await document.fonts.ready;
        await Promise.all(dropdown.getAnimations().map((animation) => animation.finished));
      });
      const createAgent = menu.getByRole("menuitem", {
        name: "Create new agent",
        exact: true,
      });
      for (const scale of [1, 1.4]) {
        await page.evaluate((value) => {
          document.documentElement.style.setProperty("--control-ui-text-scale", String(value));
        }, scale);
        await expect
          .poll(() =>
            createAgent.evaluate((item) => {
              const label = item.querySelector(".agent-select__option-label");
              if (!label) {
                throw new Error("Create agent label is missing");
              }
              return label.getBoundingClientRect().right - item.getBoundingClientRect().right;
            }),
          )
          .toBeLessThanOrEqual(0);
      }
      await expectFocused(mainSwitch);
      await pressAndExpectFocus(page, "r", researchSwitch);
      const researchSettings = researchSwitch.getByRole("button", { name: "Research settings" });
      await pressAndExpectFocus(page, "Tab", researchSettings);
      await page.keyboard.press("Enter");
      await waitForControlUiRoute(page, {
        routeId: "agents",
        pathname: "/settings/agents/research",
      });
      expect(await page.evaluate(() => window.openclawControlUi?.snapshot().sessionKey)).toBe(
        "agent:main:main",
      );
      await page.locator(".settings-sidebar__back").click();
      await waitForControlUiRoute(page, { routeId: "chat" });
      await sidebar.locator(".sidebar-agent-card__main").click();
      await expectAttribute(mainSwitch, "aria-current", "true");
      await researchSwitch.focus();
      await page.keyboard.press("Enter");
      await expectPath(page, controlUiSessionPath("agent:research:main"));
      const card = sidebar.locator("openclaw-sidebar-agent-card");
      await expectText(card.locator(".sidebar-agent-card__name"), "Research");
      const image = card.locator(".sidebar-agent-card__avatar img");
      await expect.poll(() => image.getAttribute("src")).toBe(pixelAvatar);
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBe(1);
      await sidebar.locator(".sidebar-agent-card__main").click();
      await menu.getByRole("menuitem", { name: "Show all", exact: true }).click();
      await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
      await sidebar.locator(".sidebar-workspace-header__main").click();
      await expectAttribute(
        menu.getByRole("menuitem", { name: "Show all", exact: true }),
        "aria-current",
        "true",
      );
    });
  });

  it("keeps crowded agent-menu actions inside the available viewport", async () => {
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
        await page.locator("openclaw-app-sidebar .sidebar-agent-card__main").click();
        const menu = page.locator("openclaw-app-sidebar .sidebar-agent-menu");
        await menu.evaluate(async (dropdown) => {
          await document.fonts.ready;
          await Promise.all(dropdown.getAnimations().map((animation) => animation.finished));
        });
        expect(
          await menu.evaluate((dropdown) =>
            [...dropdown.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]')].every(
              (action) => {
                const box = action.getBoundingClientRect();
                return box.top >= 0 && box.bottom <= innerHeight;
              },
            ),
          ),
        ).toBe(true);
        const duplicateNames = menu
          .locator('.sidebar-agent-menu__agent-list > [role^="menuitem"]')
          .filter({ hasText: "Support" });
        expect(await duplicateNames.count()).toBe(2);
        expect(await duplicateNames.locator(".agent-select__option-description").count()).toBe(0);
      },
    );
  });
});
