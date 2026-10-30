// Control UI tests cover customizable sidebar navigation and persistence.
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import {
  controlUiSessionPath,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { revealSidebarTarget } from "../test-helpers/control-ui-sidebar-window.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages, openSidebarPinMenu } from "./sidebar-customization.test-support.ts";
import { expandSidebarSessions } from "./sidebar-session-pagination.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar customization mocked Gateway E2E",
  startServerBeforeBrowser: true,
  // Pointer coverage needs visible native scrollbars with a measurable gutter.
  browserLaunchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar,OverlayScrollbars"],
  },
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const hiddenSessionCatalogsStorageKey = "openclaw:sidebar:sessions:hidden-catalogs";

async function trimmedTextContents(locator: Locator): Promise<string[]> {
  return (await locator.allTextContents()).map((text) => text.trim());
}

async function roundedWidth(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.width ?? 0);
}

suite.define(() => {
  it.each(["ltr", "rtl"] as const)(
    "keeps the sidebar scrollbar separate from its resize target in %s",
    async (direction) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 954, width: 1105 } },
        async ({ page }) => {
          await installMockGateway(page, {
            sessions: Array.from({ length: 40 }, (_, index) => ({
              key: `agent:main:divider-session-${index}`,
              label: `Project checkpoint ${index + 1}`,
              kind: "direct",
              updatedAt: 1_800_000_000_000 - index * 60_000,
            })),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const body = page.locator(".sidebar-shell__body");
          const nav = page.locator(".shell-nav");
          const resizer = page.getByRole("separator", { name: "Resize sidebar" });
          await expandSidebarSessions(body, 40);
          await revealSidebarTarget(
            body,
            body.locator('[data-session-key="agent:main:divider-session-39"]'),
          );
          await expect
            .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
            .toBe(true);
          await page.evaluate((pageDirection) => {
            document.documentElement.dir = pageDirection;
          }, direction);
          await expect
            .poll(() => body.evaluate((element) => getComputedStyle(element).direction))
            .toBe(direction);
          await body.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          const bounds = await body.boundingBox();
          expect(bounds).not.toBeNull();
          const width = await roundedWidth(nav);
          // The center of a 16px folding control at the content edge stays clickable.
          expect(
            await page.locator("main.content").evaluate((element, pageDirection) => {
              const rect = element.getBoundingClientRect();
              const x = pageDirection === "rtl" ? rect.right - 8 : rect.left + 8;
              const hit = document.elementFromPoint(x, rect.top + 50);
              return hit !== null && element.contains(hit);
            }, direction),
          ).toBe(true);
          const scrollbarWidth = await body.evaluate(
            (element) => element.getBoundingClientRect().width - element.clientWidth,
          );
          expect(scrollbarWidth).toBeGreaterThan(0);
          const x =
            direction === "rtl"
              ? bounds!.x + scrollbarWidth / 2
              : bounds!.x + bounds!.width - scrollbarWidth / 2;
          const y = bounds!.y + 50;
          expect(
            await page.evaluate(
              (point) =>
                document.elementFromPoint(point.x, point.y)?.closest("resizable-divider") === null,
              { x, y },
            ),
          ).toBe(true);
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, y + 120, { steps: 12 });
          await page.mouse.up();
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          expect(await roundedWidth(nav)).toBe(width);
          const resizeBounds = await resizer.boundingBox();
          expect(resizeBounds).not.toBeNull();
          const resizeX = resizeBounds!.x + resizeBounds!.width / 2;
          await page.mouse.move(resizeX, y);
          await page.mouse.down();
          // Preserve the existing physical-delta resize contract in both directions.
          await page.mouse.move(resizeX + 60, y, { steps: 6 });
          await page.mouse.up();
          await expect.poll(() => roundedWidth(nav)).toBe(width + 60);
          await resizer.focus();
          await page.keyboard.press("Home");
          await expect.poll(() => roundedWidth(nav)).toBe(292);
        },
      );
    },
  );

  it.each([1440, 390])(
    "keeps Systems and Workboard nav controls aligned and separated at %i px",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width } },
        async ({ page }) => {
          const boards = [
            { id: "default", total: 0, active: 0, archived: 0, byStatus: {} },
            { id: "ops", name: "Operations", total: 0, active: 0, archived: 0, byStatus: {} },
          ];
          await installMockGateway(page, {
            ...workboardUi,
            methodResponses: {
              "workboard.boards.list": { boards },
              "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
            },
          });
          await seedChatSettings(page, suite.server.baseUrl, {
            sidebarAgentsMode: "roster",
            railShortcuts: [
              "route:sessions",
              "route:systems",
              "plugin:workboard/workboard",
              "route:cron",
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          if (width < 900) {
            await navigationDrawerToggle(page).click();
          }
          const sidebar = page.locator("openclaw-app-sidebar");
          for (const { entry, label } of [
            { entry: "route:systems", label: "Systems" },
            { entry: "plugin:workboard/workboard", label: "Workboard" },
          ]) {
            if (label === "Workboard") {
              const pages = await openSidebarPages(page);
              await pages.getByRole("link", { name: "Operations", exact: true }).click();
              await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
              await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
              if (
                width < 900 &&
                (await navigationDrawerToggle(page).getAttribute("aria-expanded")) === "false"
              ) {
                await navigationDrawerToggle(page).click();
              }
            }
            const row = sidebar.locator('.sidebar-rail__pin[data-sidebar-entry="' + entry + '"]');
            await row.waitFor();
            expect(await row.locator(".nav-item--child").count()).toBe(0);
            const originalBox = await row.boundingBox();
            expect(originalBox).not.toBeNull();
            const order = () =>
              sidebar
                .locator(".sidebar-rail__pin")
                .evaluateAll((pins) => pins.map((pin) => pin.getAttribute("data-sidebar-entry")));
            const expected = await order();
            const index = expected.indexOf(entry);
            expect(index).toBeGreaterThan(0);
            [expected[index - 1], expected[index]] = [expected[index]!, expected[index - 1]!];
            const navLink = row.locator(".nav-item").first();
            await navLink.click({ button: "right" });
            await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
            await expect.poll(order).toEqual(expected);
            const [iconBox, rowBox, linkBox] = await Promise.all([
              row.locator(".nav-item__icon").first().boundingBox(),
              row.boundingBox(),
              navLink.boundingBox(),
            ]);
            expect(iconBox).not.toBeNull();
            expect(rowBox).not.toBeNull();
            expect(linkBox).not.toBeNull();
            expect(rowBox!.height).toBe(originalBox!.height);
            expect(rowBox!.height).toBe(linkBox!.height);
            expect(
              Math.abs(iconBox!.x + iconBox!.width / 2 - (linkBox!.x + linkBox!.width / 2)),
            ).toBeLessThanOrEqual(1);
            if (label === "Workboard") {
              const pages = await openSidebarPages(page);
              const operationsEntry = pages.locator(
                '[data-sidebar-entry="plugin:workboard/board-ops"]',
              );
              await operationsEntry
                .getByRole("link", { name: "Operations", exact: true })
                .waitFor();
              // Pages owns a flat entry for every registration, including plugin children.
              expect(
                await pages.getByRole("link", { name: "Operations", exact: true }).count(),
              ).toBe(1);
              expect(
                await pages
                  .locator('[data-sidebar-entry^="plugin:workboard/"] a')
                  .evaluateAll((links) =>
                    links
                      .map((link) => link.getAttribute("href"))
                      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
                  ),
              ).toEqual(["/workboard", "/workboard/default", "/workboard/ops"]);
              expect(await pages.locator(".nav-item--child").count()).toBe(0);
              expect(await row.locator(".nav-item--child").count()).toBe(0);
              if (width === 1440) {
                const operationsPage = pages.locator(".sidebar-pages__entry").filter({
                  has: page.locator('[data-sidebar-entry="plugin:workboard/board-ops"]'),
                });
                await operationsPage.getByRole("button", { name: "Pin", exact: true }).click();
                const shortcut = sidebar.locator(
                  '.sidebar-rail__pin[data-sidebar-entry="plugin:workboard/board-ops"]',
                );
                await shortcut.getByRole("link", { name: "Operations", exact: true }).waitFor();
                await pages.locator('a[href="/workboard/default"]').click();
                await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/default");
                await shortcut.getByRole("link", { name: "Operations", exact: true }).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
                await openSidebarPages(page);
                await pages.getByRole("link", { name: "Workboard", exact: true }).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard");
                await operationsPage.getByRole("button", { name: "Unpin", exact: true }).click();
                await expect.poll(() => shortcut.count()).toBe(0);
                expect(await operationsEntry.getByRole("link").count()).toBe(1);
              }
            }
          }
        },
      );
    },
  );

  it("uses catalog labels in the hidden-section recovery rows", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: hiddenSessionCatalogsStorageKey,
      value: ["claude", "offline-catalog"],
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: true, archive: false },
              hosts: [],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      const sidebarSettings = page.locator("#settings-appearance-sidebar");
      await sidebarSettings.scrollIntoViewIfNeeded();
      const labelsRequest = await gateway.waitForRequest("sessions.catalog.list", {
        match: { metadataOnly: true },
      });
      expect(labelsRequest.params).not.toHaveProperty("limitPerHost");
      await sidebarSettings.getByRole("heading", { name: "Hidden session sections" }).waitFor();
      const recovery = sidebarSettings.locator(".settings-group", { hasText: "offline-catalog" });
      const row = recovery.locator(".settings-row", { hasText: "Claude Code" });
      await expect.poll(() => recovery.textContent()).toContain("Claude Code");
      await expect.poll(() => recovery.textContent()).toContain("offline-catalog");
      expect(await recovery.getByText("claude", { exact: true }).count()).toBe(0);

      await row.getByRole("button", { name: "Show" }).click();
      await expect.poll(() => row.count()).toBe(0);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), hiddenSessionCatalogsStorageKey),
      ).toBe('["offline-catalog"]');
    } finally {
      await context.close();
    }
  });

  it("pins and unpins routes and persists navigation state across reloads", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
      methodResponses: {
        "config.get": {
          config: {},
          hash: "settings-search-e2e",
        },
        "config.schema": {
          schema: {
            type: "object",
            properties: {
              browser: {
                type: "object",
                title: "Browser",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enabled",
                  },
                },
              },
              tools: {
                type: "object",
                title: "Tools",
                properties: {
                  profile: {
                    type: "string",
                    description: "Controls sandbox access",
                  },
                },
              },
            },
          },
          uiHints: {},
          version: "e2e",
          generatedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const sidebar = page.locator("openclaw-app-sidebar");
      const pinnedItems = sidebar.locator(
        '.sidebar-rail__pin[data-sidebar-entry^="route:"] .nav-item',
      );
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual([]);
      // Desktop renders no topbar row: the sidebar owns navigation.
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
      const shellNav = page.locator(".shell-nav");
      const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
      await expect.poll(() => roundedWidth(shellNav)).toBe(310);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("310 pixels");

      const resizerBounds = await sidebarResizer.boundingBox();
      if (!resizerBounds) {
        throw new Error("expected visible desktop sidebar resizer");
      }
      const resizerX = resizerBounds.x + resizerBounds.width / 2;
      const resizerY = resizerBounds.y + resizerBounds.height / 2;
      await page.mouse.move(resizerX, resizerY);
      await expect
        .poll(() =>
          page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), {
            x: resizerX,
            y: resizerY,
          }),
        )
        .toBe("resizable-divider");
      await page.mouse.down();
      await expect.poll(() => sidebarResizer.getAttribute("class")).toContain("dragging");
      await page.mouse.move(resizerX + 100, resizerY);
      await page.mouse.up();
      await expect.poll(() => roundedWidth(shellNav)).toBe(410);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("410 pixels");

      await page.reload();
      await expect.poll(() => roundedWidth(shellNav)).toBe(410);
      // Persisted shell width is restored before the reloaded chat route commits.
      await waitForControlUiRoute(page, { pathnamePrefix: "/chat", routeId: "chat" });
      await page.setViewportSize({ height: 900, width: 1300 });
      await expect.poll(() => roundedWidth(shellNav)).toBe(410);
      await sidebarResizer.focus();
      await page.keyboard.press("Home");
      await expect.poll(() => roundedWidth(shellNav)).toBe(292);
      await page.keyboard.press("End");
      await expect.poll(() => roundedWidth(shellNav)).toBe(452);
      // Settings takes over the whole app: the regular sidebar yields to the
      // settings sidebar until "Back to app" (or Escape) exits. Settings opens
      // through the footer identity card's account utility menu.
      const identityCard = sidebar.locator(".sidebar-identity-card");
      const openSettingsFromIdentity = async () => {
        await identityCard.click();
        await sidebar
          .locator(".sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
      };
      await expect.poll(() => identityCard.isVisible()).toBe(true);
      await openSettingsFromIdentity();
      const { search: settingsSearch, sidebar: settingsSidebar } =
        await waitForControlUiSettingsTakeover(page);
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "Appearance" })
            .first()
            .getAttribute("aria-current"),
        )
        .toBe("page");
      const settingsLinks = settingsSidebar.locator(".settings-sidebar__item");
      expect(await trimmedTextContents(settingsLinks)).not.toContain("Agent Defaults");
      await expect
        .poll(() =>
          settingsSearch.evaluate((input) => {
            const firstLink = input.closest(".settings-sidebar")?.querySelector("a");
            return firstLink
              ? Boolean(input.compareDocumentPosition(firstLink) & Node.DOCUMENT_POSITION_FOLLOWING)
              : false;
          }),
        )
        .toBe(true);
      await settingsSearch.fill("mcp");
      await settingsSidebar.getByRole("link", { name: "MCP" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/mcp");
      await settingsSearch.fill("system");
      await expect
        .poll(() => trimmedTextContents(settingsLinks))
        .toEqual([
          "Ask OpenClaw",
          "Approvals",
          "Infrastructure",
          "Labs",
          "Advanced",
          "Debug",
          "Logs",
          "Updates",
          "About",
          "Profile",
          "Appearance",
          "Notifications",
          "Gateway",
        ]);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/mcp");
      await settingsSearch.fill("browser");
      const browserResult = settingsSidebar.getByRole("link", {
        name: "Browser",
        exact: true,
      });
      await expect.poll(() => browserResult.isVisible()).toBe(true);
      await browserResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/infrastructure");
      // Browser is an advanced-tier section (#112538): search navigation
      // carries the advanced=1 reveal intent.
      await expect.poll(() => new URL(page.url()).search).toBe("?section=browser&advanced=1");
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-browser");
      await expect.poll(() => page.locator("#config-section-browser").isVisible()).toBe(true);

      await settingsSearch.fill("session observer");
      const sidebarPreferencesResult = settingsSidebar.getByRole("link", {
        exact: true,
        name: "Sidebar",
      });
      await expect.poll(() => sidebarPreferencesResult.isVisible()).toBe(true);
      await sidebarPreferencesResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=__appearance__");
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-appearance-sidebar");
      await expect
        .poll(() =>
          page
            .locator("#settings-appearance-sidebar")
            .getByRole("heading", { name: "Session observer" })
            .isVisible(),
        )
        .toBe(true);

      await settingsSearch.fill("message width");
      const chatPreferencesResult = settingsSidebar.getByRole("link", {
        exact: true,
        name: "Chat",
      });
      await expect.poll(() => chatPreferencesResult.isVisible()).toBe(true);
      await chatPreferencesResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=__appearance__");
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-appearance-chat");
      await expect
        .poll(() =>
          page
            .locator("#settings-appearance-chat")
            .getByText("Message width", { exact: true })
            .isVisible(),
        )
        .toBe(true);

      await settingsSearch.fill("");
      await settingsSidebar.getByRole("link", { name: "Agents", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents");
      const agentDefaultsRow = page.getByRole("button", {
        name: "Agent defaults Defaults every agent inherits unless overridden.",
      });
      await expect.poll(() => agentDefaultsRow.isVisible()).toBe(true);
      await agentDefaultsRow.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "Agents", exact: true })
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await settingsSearch.fill("sandbox access");
      const toolsResult = settingsSidebar.getByRole("link", { name: "Tools", exact: true });
      await expect.poll(() => toolsResult.isVisible()).toBe(true);
      await toolsResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=tools&advanced=1");
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-tools");
      await settingsSearch.fill("channel");
      const channelsResult = settingsSidebar.getByRole("link", { name: "Channels" }).first();
      await channelsResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
      await expect.poll(() => settingsSearch.inputValue()).toBe("channel");
      await expect.poll(() => channelsResult.getAttribute("aria-current")).toBe("page");
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath("main"));
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await openSettingsFromIdentity();
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => settingsSearch.inputValue()).toBe("");
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--onboarding");
      // Ask OpenClaw is a settings-takeover page (#111686): the settings
      // sidebar owns navigation there, not the app sidebar.
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      await expect
        .poll(() => page.getByRole("button", { name: "Exit setup" }).isVisible())
        .toBe(false);
      await page.goto(`${suite.server.baseUrl}chat`);

      const pagesButton = sidebar.getByRole("button", { name: "Pages", exact: true });
      let pages = await openSidebarPages(page);
      expect(await pages.getByRole("link", { name: "Logbook", exact: true }).isVisible()).toBe(
        true,
      );
      await expect.poll(() => trimmedTextContents(pinnedItems)).not.toContain("Logbook");
      expect(await pages.getByRole("link", { name: "Workboard", exact: true }).count()).toBe(0);
      expect(await pages.getByRole("link", { name: "OpenClaw", exact: true }).count()).toBe(0);
      const usage = pages
        .locator(".sidebar-pages__entry")
        .filter({ has: page.getByRole("link", { name: "Usage", exact: true }) });
      await usage.getByRole("button", { name: "Pin", exact: true }).click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      // A pinned page keeps a filled pin at rest, and hovering the pin keeps the
      // whole entry, pin included, inside the row highlight.
      const usagePin = usage.getByRole("button", { name: "Unpin", exact: true });
      await page.mouse.move(900, 600);
      await expect
        .poll(() =>
          usagePin.evaluate((pin) => ({
            opacity: getComputedStyle(pin).opacity,
            filled: getComputedStyle(pin.querySelector("svg")!).fill !== "none",
          })),
        )
        .toEqual({ opacity: "1", filled: true });
      await usagePin.hover();
      await expect
        .poll(() => usage.evaluate((entry) => getComputedStyle(entry).backgroundColor))
        .not.toBe("rgba(0, 0, 0, 0)");
      const railUsage = pinnedItems.first();
      await railUsage.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.reload();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      // The transient selected view resets, but saved personal pins do not.
      await expect.poll(() => pagesButton.getAttribute("aria-pressed")).toBe("false");
      pages = await openSidebarPages(page);
      expect(await pages.getByRole("link", { name: "Usage", exact: true }).isVisible()).toBe(true);
      const pinMenu = await openSidebarPinMenu(page, "route:usage");
      await pinMenu.getByRole("menuitem", { name: "Unpin", exact: true }).click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual([]);
      expect(await pages.getByRole("link", { name: "Usage", exact: true }).isVisible()).toBe(true);

      // The rail search button is the command palette entry point.
      const searchButton = page.locator(".sidebar-brand__search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expect.poll(() => paletteInput.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput.isVisible()).toBe(false);

      // Collapsing the list retains the personal icon rail; its view buttons
      // provide the matching expand controls.
      const collapseButton = page.locator('[data-navigation-view][aria-pressed="true"]');
      await collapseButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");
      await expect
        .poll(() =>
          page
            .locator(".shell")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--shell-nav-width")),
        )
        .toBe("52px");
      await expect.poll(() => sidebarResizer.count()).toBe(0);
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect.poll(() => sidebar.locator(".sidebar-shell").isVisible()).toBe(false);
      await expect.poll(() => sidebar.locator(".sidebar-rail").isVisible()).toBe(true);
      await expect.poll(() => pagesButton.isVisible()).toBe(true);
      await page.reload();
      // Sidebar visibility is tab-local and intentionally not persisted; width is.
      await expect.poll(() => collapseButton.isVisible()).toBe(true);
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-collapsed");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect.poll(() => roundedWidth(shellNav)).toBe(452);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("452 pixels");
      await collapseButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = navigationDrawerToggle(page);
      await expect.poll(() => drawerButton.isVisible()).toBe(true);
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      await expect.poll(() => pagesButton.isVisible()).toBe(true);
      await expect.poll(() => sidebarResizer.isVisible()).toBe(false);
      await expect
        .poll(() =>
          page
            .locator(".shell")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--shell-nav-width")),
        )
        .toBe("0px");
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().left),
        )
        .toBe(0);
      // Narrow Chat merges navigation controls into its title bar.
      await expect.poll(() => page.locator(".agent-chat__header--mobile").isVisible()).toBe(true);

      // Widening with the drawer open must not leave its stale state blocking
      // the desktop collapse control.
      await page.setViewportSize({ height: 900, width: 1440 });
      await collapseButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-drawer-open");

      await page.setViewportSize({ height: 900, width: 900 });
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-drawer-open");
      await page.setViewportSize({ height: 852, width: 393 });
      await expect.poll(() => page.locator(".agent-chat__header--mobile").isVisible()).toBe(true);
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  it("keeps Home activity and unsent attention stable while rail controls appear", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessions: [
            { hasActiveRun: true, key: "main", kind: "direct", status: "running", updatedAt: 100 },
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const pages = await openSidebarPages(page);
        await pages
          .locator(".sidebar-pages__entry")
          .filter({ has: page.getByRole("link", { name: "Sessions", exact: true }) })
          .getByRole("button", { name: "Pin", exact: true })
          .click();
        await sidebar.getByRole("button", { name: "Sessions", exact: true }).click();
        const home = sidebar.locator(".sidebar-footer-bar__home");
        await expect.poll(() => home.isVisible()).toBe(true);
        await sidebar.evaluate((element) => {
          // This layout fixture supplies the sidebar's declared presentation input.
          (element as AppSidebarElement).storedOutboxes = {
            total: 1,
            attentionCountForSession: () => 1,
            hasSessionDraft: () => false,
          };
        });

        const activity = home.locator(".session-glyph");
        const shortcut = sidebar
          .locator('.sidebar-rail__pin[data-sidebar-entry="route:sessions"]')
          .getByRole("link", { name: "Sessions", exact: true });
        await expect
          .poll(() => home.locator(".session-glyph--running .session-glyph__ring").count())
          .toBe(1);
        await expect.poll(() => home.locator(".session-row-badge--attention").count()).toBe(1);

        await page.mouse.move(900, 400);
        const restingActivity = await activity.boundingBox();
        expect(restingActivity).not.toBeNull();
        await shortcut.focus();
        await page.keyboard.press("Shift+F10");
        await page
          .locator(".sidebar-rail-pin-menu")
          .getByRole("menuitem", { name: "Unpin", exact: true })
          .waitFor();
        await expect
          .poll(async () => {
            const [homeBox, activityBox, shortcutBox] = await Promise.all([
              home.boundingBox(),
              activity.boundingBox(),
              shortcut.boundingBox(),
            ]);
            if (!homeBox || !activityBox || !shortcutBox || !restingActivity) {
              return null;
            }
            return {
              activityShift: Math.round(restingActivity.x - activityBox.x),
              centerDelta: Math.abs(
                activityBox.x + activityBox.width / 2 - (homeBox.x + homeBox.width / 2),
              ),
              clearOfShortcut: shortcutBox.y + shortcutBox.height < homeBox.y,
            };
          })
          .toEqual({ activityShift: 0, centerDelta: 0, clearOfShortcut: true });
      },
    );
  });

  it("keeps mobile attention in the drawer while desktop remains unchanged", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [
                compactCronJobFixture({
                  id: "release-digest",
                  name: "Release digest",
                  enabled: true,
                  createdAtMs: 0,
                  updatedAtMs: 0,
                  schedule: { kind: "every", everyMs: 60_000 },
                  sessionTarget: "isolated",
                  wakeMode: "now",
                  payload: { kind: "agentTurn", message: "test" },
                  state: {
                    lastRunStatus: "error",
                    lastError: "Provider request failed",
                  },
                }),
              ],
              snapshotRevision: "sidebar-mobile-attention",
              total: 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "models.authStatus": { providers: [], ts: 1 },
          },
        });

        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("cron.list");
        await gateway.emitGatewayEvent("update.available", {
          schedule: {
            autoEnabled: false,
            channel: "beta",
            install: { kind: "git", git: { status: "behind", commitsBehind: 246 } },
            target: {
              kind: "git",
              commitsBehind: 246,
              upstreamRef: "origin/main",
              upstreamSha: "9f3c21a0000000000000000000000000000000aa",
            },
          },
          updateAvailable: {
            channel: "beta",
            commitsBehind: 246,
            currentSha: "1111111111111111111111111111111111111111",
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.1",
            upstreamRef: "origin/main",
            upstreamSha: "9f3c21a0000000000000000000000000000000aa",
          },
        });

        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarUpdate = sidebar.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        const sidebarAutomation = sidebar.locator('[data-attention-kind="cronFailed"]');
        await expect.poll(() => sidebar.locator(".sidebar-issues-button__count").count()).toBe(1);
        await sidebar.locator(".sidebar-issues-button").click();
        await expect.poll(() => sidebarUpdate.count()).toBe(1);
        await expect.poll(() => sidebarAutomation.count()).toBe(1);
        await sidebar.locator(".sidebar-issues-button").click();

        await page.setViewportSize({ height: 852, width: 393 });
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--mobile-nav");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const floatingKinds = await page
          .locator(".sidebar-attention--floating [data-attention-kind]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-attention-kind")),
          );

        await navigationDrawerToggle(page).click();
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-drawer-open");
        await sidebar.locator(".sidebar-issues-button").click();
        await expect.poll(() => sidebarUpdate.isVisible()).toBe(true);
        await expect.poll(() => sidebarAutomation.isVisible()).toBe(true);

        expect(floatingKinds).toEqual([]);
      },
    );
  });
});
