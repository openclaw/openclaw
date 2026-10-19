import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import {
  controlUiSessionPath,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectPath,
  expectVisible,
} from "./sidebar-assertions.test-support.ts";
import { openSidebarPages, openSidebarPinMenu } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar customization mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const desktopOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} satisfies BrowserContextOptions;
const exactLink = (root: Page | Locator, name: string) =>
  root.getByRole("link", { name, exact: true });
const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const schemaObject = (properties: Record<string, unknown>, title?: string) => ({
  type: "object",
  properties,
  ...(title ? { title } : {}),
});
const hiddenSessionCatalogsStorageKey = "openclaw:sidebar:sessions:hidden-catalogs";

async function trimmedTextContents(locator: Locator): Promise<string[]> {
  return (await locator.allTextContents()).map((text) => text.trim());
}

async function roundedWidth(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.width ?? 0);
}

suite.define(() => {
  it.each(
    [1440, 390].flatMap((width) => [
      { width, entry: "route:systems", label: "Systems", route: "chat" },
      { width, entry: "plugin:workboard/workboard", label: "Workboard", route: "workboard/ops" },
    ]),
  )(
    "keeps $label nav controls aligned and separated at $width px",
    async ({ width, entry, label, route }) => {
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
            railShortcuts: ["route:agents-home", entry, "route:cron"],
          });
          await page.goto(`${suite.server.baseUrl}${route}`);
          if (label === "Workboard") {
            await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
          }
          if (width < 900) {
            await navigationDrawerToggle(page).click();
          }
          const sidebar = page.locator("openclaw-app-sidebar");
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
          expect([iconBox, rowBox, linkBox]).not.toContain(null);
          expect(rowBox!.height).toBe(originalBox!.height);
          expect(rowBox!.height).toBe(linkBox!.height);
          expect(
            Math.abs(iconBox!.x + iconBox!.width / 2 - (linkBox!.x + linkBox!.width / 2)),
          ).toBeLessThanOrEqual(1);
          expect(await row.locator(".sidebar-reorder-trigger").count()).toBe(0);
          if (label === "Workboard") {
            const pages = await openSidebarPages(page);
            const operationsEntry = pages.locator(
              '[data-sidebar-entry="plugin:workboard/board-ops"]',
            );
            await exactLink(operationsEntry, "Operations").waitFor();
            // Pages owns a flat entry for every registration, including plugin children.
            expect(await exactLink(pages, "Operations").count()).toBe(1);
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
            if (width === 1440) {
              const operationsPage = pages.locator(".sidebar-pages__entry").filter({
                has: page.locator('[data-sidebar-entry="plugin:workboard/board-ops"]'),
              });
              await button(operationsPage, "Pin").click();
              const shortcut = sidebar.locator(
                '.sidebar-rail__pin[data-sidebar-entry="plugin:workboard/board-ops"]',
              );
              await exactLink(shortcut, "Operations").waitFor();
              await pages.locator('a[href="/workboard/default"]').click();
              await expectPath(page, "/workboard/default");
              await exactLink(shortcut, "Operations").click();
              await expectPath(page, "/workboard/ops");
              await openSidebarPages(page);
              await exactLink(pages, "Workboard").click();
              await expectPath(page, "/workboard");
              await button(operationsPage, "Unpin").click();
              await expectCount(shortcut, 0);
              expect(await operationsEntry.getByRole("link").count()).toBe(1);
            }
          }
        },
      );
    },
  );

  it("uses catalog labels in the hidden-section recovery rows", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
      await page.addInitScript(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        {
          key: hiddenSessionCatalogsStorageKey,
          value: ["claude", "offline-catalog"],
        },
      );
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

      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      const labelsRequest = await gateway.waitForRequest("sessions.catalog.list", {
        match: { metadataOnly: true },
      });
      expect(labelsRequest.params).not.toHaveProperty("limitPerHost");
      const sidebarSettings = page.locator("#settings-appearance-sidebar");
      await sidebarSettings.getByRole("heading", { name: "Hidden session sections" }).waitFor();
      const recovery = sidebarSettings.locator(".settings-group", { hasText: "offline-catalog" });
      const row = recovery.locator(".settings-row", { hasText: "Claude Code" });
      await expect.poll(() => recovery.textContent()).toContain("Claude Code");
      await expect.poll(() => recovery.textContent()).toContain("offline-catalog");
      expect(await recovery.getByText("claude", { exact: true }).count()).toBe(0);

      await row.getByRole("button", { name: "Show" }).click();
      await expectCount(row, 0);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), hiddenSessionCatalogsStorageKey),
      ).toBe('["offline-catalog"]');
    });
  });

  it("pins and unpins routes and persists navigation state across reloads", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
      await installMockGateway(page, {
        controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
        methodResponses: {
          "config.get": {
            config: {},
            hash: "settings-search-e2e",
          },
          "config.schema": {
            schema: schemaObject({
              browser: schemaObject({ enabled: { type: "boolean", title: "Enabled" } }, "Browser"),
              tools: schemaObject(
                { profile: { type: "string", description: "Controls sandbox access" } },
                "Tools",
              ),
            }),
            uiHints: {},
            version: "e2e",
            generatedAt: "2026-07-12T00:00:00.000Z",
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);

      const sidebar = page.locator("openclaw-app-sidebar");
      const shell = page.locator(".shell");
      const expectShellWidth = async (width: string) => {
        await expect
          .poll(() =>
            shell.evaluate((element) =>
              getComputedStyle(element).getPropertyValue("--shell-nav-width"),
            ),
          )
          .toBe(width);
      };
      const expectShellFlag = async (flag: string, present = true) => {
        await expect
          .poll(() =>
            shell.evaluate((element, token) => element.classList.contains(token), "shell--" + flag),
          )
          .toBe(present);
      };
      const pinnedItems = sidebar.locator(
        '.sidebar-rail__pin[data-sidebar-entry^="route:"] .nav-item',
      );
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual([]);
      await expectVisible(page.locator(".topbar"), false);
      const shellNav = page.locator(".shell-nav");
      const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
      const expectWidth = async (width: number) => {
        await expect
          .poll(async () => ({
            pixels: await roundedWidth(shellNav),
            label: await sidebarResizer.getAttribute("aria-valuetext"),
          }))
          .toEqual({ pixels: width, label: width + " pixels" });
      };
      await expectWidth(310);

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
      await expectWidth(410);

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
      const identityCard = sidebar.locator(".sidebar-identity-card");
      const openSettingsFromIdentity = async () => {
        await identityCard.click();
        await sidebar
          .locator(".sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
      };
      await expectVisible(identityCard);
      await openSettingsFromIdentity();
      const { search: settingsSearch, sidebar: settingsSidebar } =
        await waitForControlUiSettingsTakeover(page);
      await expectAttribute(
        settingsSidebar.getByRole("link", { name: "Appearance" }).first(),
        "aria-current",
        "page",
      );
      const settingsLinks = settingsSidebar.locator(".settings-sidebar__item");
      const expectSearch = async (query: string, labels: string[], nested = false) => {
        await settingsSearch.fill(query);
        const links = nested
          ? settingsSidebar.locator(
              ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
            )
          : settingsLinks;
        await expect.poll(() => trimmedTextContents(links)).toEqual(labels);
      };
      const searchSection = async (query: string, label: string, destination: string) => {
        await settingsSearch.fill(query);
        const result = exactLink(settingsSidebar, label);
        await expectVisible(result);
        await result.click();
        const { pathname, search, hash } = new URL(destination, page.url());
        await expect.poll(() => new URL(page.url())).toMatchObject({ pathname, search, hash });
      };
      const allSettingsLabels = await trimmedTextContents(settingsLinks);
      expect(allSettingsLabels).not.toContain("Agent Defaults");
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
      await expectSearch("cp", ["Gateway", "Gateway Host"], true);
      await expectSearch("mcp", ["MCP"], true);
      await settingsSidebar.getByRole("link", { name: "MCP" }).click();
      await expectPath(page, "/settings/mcp");
      await expectSearch("  ThEmE  ", ["Appearance"]);
      await expectPath(page, "/settings/mcp");
      await expectSearch("system", [
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
      // Advanced search results must carry the reveal intent (#112538).
      await searchSection(
        "browser",
        "Browser",
        "/settings/infrastructure?section=browser&advanced=1#config-section-browser",
      );
      await expectVisible(page.locator("#config-section-browser"));

      await searchSection(
        "session observer",
        "Sidebar",
        "/settings/appearance?section=__appearance__#settings-appearance-sidebar",
      );
      await expectVisible(
        page
          .locator("#settings-appearance-sidebar")
          .getByRole("heading", { name: "Session observer" }),
      );
      await searchSection(
        "message width",
        "Chat",
        "/settings/appearance?section=__appearance__#settings-appearance-chat",
      );
      await expectVisible(
        page.locator("#settings-appearance-chat").getByText("Message width", { exact: true }),
      );

      await settingsSearch.fill("does-not-exist");
      await expectCount(settingsLinks, 0);
      await expect
        .poll(() => settingsSidebar.getByRole("status").textContent())
        .toContain("No matching settings.");
      await settingsSidebar.getByRole("button", { name: "Clear settings search" }).click();
      await expect.poll(() => trimmedTextContents(settingsLinks)).toEqual(allSettingsLabels);
      await exactLink(settingsSidebar, "Agents").click();
      await expectPath(page, "/settings/agents");
      const agentDefaultsRow = page.getByRole("button", {
        name: "Agent defaults Defaults every agent inherits unless overridden.",
      });
      await expectVisible(agentDefaultsRow);
      await agentDefaultsRow.click();
      await expectPath(page, "/settings/ai-agents");
      await expectAttribute(exactLink(settingsSidebar, "Agents"), "aria-current", "page");
      await searchSection(
        "sandbox access",
        "Tools",
        "/settings/ai-agents?section=tools&advanced=1#config-section-tools",
      );
      await settingsSearch.fill("channel");
      const channelsResult = settingsSidebar.getByRole("link", { name: "Channels" }).first();
      await channelsResult.click();
      await expectPath(page, "/settings/channels");
      await expect.poll(() => settingsSearch.inputValue()).toBe("channel");
      await expectAttribute(channelsResult, "aria-current", "page");
      await page.keyboard.press("Escape");
      await expectPath(page, controlUiSessionPath("main"));
      await expectVisible(sidebar);
      await openSettingsFromIdentity();
      await expectVisible(settingsSidebar);
      await expect.poll(() => settingsSearch.inputValue()).toBe("");
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await expectPath(page, "/custodian");
      await expectShellFlag("onboarding", false);
      // Ask OpenClaw is a settings-takeover page (#111686): the settings
      // sidebar owns navigation there, not the app sidebar.
      await expectVisible(settingsSidebar);
      await expectVisible(sidebar, false);
      await expectVisible(page.getByRole("button", { name: "Exit setup" }), false);
      await page.goto(`${suite.server.baseUrl}chat`);

      const pagesButton = button(sidebar, "Pages");
      let pages = await openSidebarPages(page);
      expect(await exactLink(pages, "Logbook").isVisible()).toBe(true);
      await expect.poll(() => trimmedTextContents(pinnedItems)).not.toContain("Logbook");
      expect(await exactLink(pages, "Workboard").count()).toBe(0);
      expect(await exactLink(pages, "OpenClaw").count()).toBe(0);
      const usage = pages
        .locator(".sidebar-pages__entry")
        .filter({ has: exactLink(page, "Usage") });
      await button(usage, "Pin").click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      // A pinned page keeps a filled pin at rest, and hovering the pin keeps the
      // whole entry, pin included, inside the row highlight.
      const usagePin = button(usage, "Unpin");
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
      const iconWidth = (locator: typeof railUsage) =>
        locator
          .locator("svg")
          .first()
          .evaluate((svg) => svg.getBoundingClientRect().width);
      const background = (locator: typeof railUsage) =>
        locator.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(await iconWidth(railUsage)).toBe(await iconWidth(pagesButton));
      const pressedBackground = await background(pagesButton);
      await railUsage.hover();
      await expect.poll(() => background(railUsage)).toBe(pressedBackground);
      await railUsage.click();
      await expectPath(page, "/usage");
      await page.mouse.move(900, 600);
      await expect.poll(() => background(railUsage)).toBe(pressedBackground);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.reload();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      await expectAttribute(pagesButton, "aria-pressed", "false");
      pages = await openSidebarPages(page);
      expect(await exactLink(pages, "Usage").isVisible()).toBe(true);
      const pinMenu = await openSidebarPinMenu(page, "route:usage");
      await pinMenu.getByRole("menuitem", { name: "Unpin", exact: true }).click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual([]);
      expect(await exactLink(pages, "Usage").isVisible()).toBe(true);

      const searchButton = page.locator(".sidebar-brand__search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expectVisible(paletteInput);
      await page.keyboard.press("Escape");
      await expectVisible(paletteInput, false);

      const collapseButton = page.locator('[data-navigation-view][aria-pressed="true"]');
      await collapseButton.click();
      await expectShellFlag("nav-collapsed");
      await expectShellWidth("52px");
      await expectCount(sidebarResizer, 0);
      await expectVisible(sidebar);
      await expectVisible(sidebar.locator(".sidebar-shell"), false);
      await expectVisible(sidebar.locator(".sidebar-rail"));
      await expectVisible(pagesButton);
      await page.reload();
      // Sidebar visibility is tab-local and intentionally not persisted; width is.
      await expectVisible(collapseButton);
      await expectShellFlag("nav-collapsed", false);
      await expectVisible(sidebar);
      await expectWidth(452);
      await collapseButton.click();
      await expectShellFlag("nav-collapsed");

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = navigationDrawerToggle(page);
      await expectVisible(drawerButton);
      await drawerButton.click();
      await expectShellFlag("nav-drawer-open");
      await expectVisible(pagesButton);
      await expectVisible(sidebarResizer, false);
      await expectShellWidth("0px");
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().left),
        )
        .toBe(0);
      // Narrow Chat merges navigation controls into its title bar.
      await expectVisible(page.locator(".chat-pane__header").first());

      // Widening with the drawer open must not leave its stale state blocking
      // the desktop collapse control.
      await page.setViewportSize({ height: 900, width: 1440 });
      await collapseButton.click();
      await expectShellFlag("nav-collapsed");
      await expectShellFlag("nav-drawer-open", false);

      await page.setViewportSize({ height: 900, width: 900 });
      await drawerButton.click();
      await expectShellFlag("nav-drawer-open");
      await page.keyboard.press("Escape");
      await expectShellFlag("nav-drawer-open", false);
      await page.setViewportSize({ height: 852, width: 393 });
      await expectVisible(page.locator(".chat-pane__header").first());
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
    });
  });

  it("keeps Home activity and unsent attention stable while rail controls appear", async () => {
    await suite.withPage(desktopOptions, async ({ page }) => {
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
        .filter({ has: exactLink(page, "Agents") })
        .getByRole("button", { name: "Pin", exact: true })
        .click();
      await button(sidebar, "Sessions").click();
      const home = sidebar.locator(".sidebar-footer-bar__home");
      await expectVisible(home);
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
        .locator('.sidebar-rail__pin[data-sidebar-entry="route:agents-home"]')
        .getByRole("link", { name: "Agents", exact: true });
      await expectCount(home.locator(".session-glyph--running .session-glyph__ring"), 1);
      await expectCount(home.locator(".session-row-badge--attention"), 1);

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
    });
  });
});
