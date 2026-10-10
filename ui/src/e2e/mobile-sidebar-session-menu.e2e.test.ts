import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  captureControlUiE2eFailureDiagnostics,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each(["coarse", "fine"] as const)(
    "separates reorder controls, colored session glyphs, and section labels with a %s pointer",
    async (pointer) => {
      await suite.withPage(
        {
          hasTouch: pointer === "coarse",
          colorScheme: "dark",
          viewport: { width: 390, height: 844 },
        },
        async ({ page }) => {
          const pinnedKey = "agent:main:release-plan";
          const groupedKey = "agent:main:review-notes";
          await installMockGateway(page, {
            sessionKey: groupedKey,
            sessionGroups: ["Research", "Operations"],
            sessions: [
              sessionRow(pinnedKey, "Release planning", 3, {
                pinned: true,
                icon: "📌",
                color: "blue",
              }),
              sessionRow(groupedKey, "Review notes", 2, {
                category: "Research",
                icon: "🔬",
                color: "purple",
              }),
              sessionRow("agent:main:follow-up", "Follow-up questions", 1, {
                category: "Operations",
              }),
            ],
            controlUiTabs: [
              { id: "reports", pluginId: "reports", label: "Reports", icon: "chartBar" },
            ],
          });
          await page.addInitScript(
            ({ key }) =>
              localStorage.setItem(
                key,
                JSON.stringify({
                  sidebarEntries: [
                    "session:agent:main:release-plan",
                    "plugin:reports/reports",
                    "route:cron",
                  ],
                }),
              ),
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, groupedKey));
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
          await waitForMobileSidebarDrawerOpen(page);
          const pinned = page.locator('[data-sidebar-entry="session:agent:main:release-plan"]');
          const plugin = page.locator('[data-sidebar-entry="plugin:reports/reports"]');
          const group = page.locator('[data-session-section="category:Research"]');
          await pinned.locator(".session-glyph").waitFor();
          await plugin.locator(".nav-item__icon").waitFor();
          await group.locator(".sidebar-recent-session").waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell-nav"),
              [pinned, plugin, group],
              { animations: "disabled" },
            );
            await writeFile(
              path.join(suite.artifactDir, "sidebar-spacing-" + pointer + ".png"),
              frame.png,
            );
          }
          for (const width of [320, 390, 768]) {
            await page.setViewportSize({ width, height: 844 });
            for (const row of [pinned, plugin]) {
              const grip = row.locator(".sidebar-reorder-trigger");
              await row.hover();
              const [button, icon, glyph] = await Promise.all([
                grip.boundingBox(),
                grip.locator("svg").boundingBox(),
                row.locator(".session-glyph, .nav-item__icon").first().boundingBox(),
              ]);
              expect(button).not.toBeNull();
              expect(icon).not.toBeNull();
              expect(glyph).not.toBeNull();
              expect(button!.width).toBeGreaterThanOrEqual(24);
              expect(icon!.x).toBeGreaterThanOrEqual(button!.x);
              expect(icon!.x + icon!.width).toBeLessThanOrEqual(button!.x + button!.width);
              expect(glyph!.x + glyph!.width).toBeLessThanOrEqual(button!.x);
              if (width === 390) {
                const previous = await row.evaluate((element) =>
                  element.previousElementSibling?.getAttribute("data-sidebar-entry"),
                );
                if (pointer === "coarse") {
                  await grip.tap();
                } else {
                  await grip.focus();
                  await page.keyboard.press("Enter");
                }
                const move = page.getByRole("menuitem", { name: "Move up", exact: true });
                if (pointer === "coarse") {
                  await move.tap();
                } else {
                  await move.press("Enter");
                }
                await move.waitFor({ state: "hidden" });
                expect(
                  await row.evaluate((element) =>
                    element.nextElementSibling?.getAttribute("data-sidebar-entry"),
                  ),
                ).toBe(previous);
              }
            }
            const menuBox = await pinned.locator("[data-sidebar-session-menu]").boundingBox();
            const reorderBox = await pinned.locator(".sidebar-reorder-trigger").boundingBox();
            expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(reorderBox!.x);
            expect(menuBox!.width).toBe(44);
            for (const colored of [
              pinned.locator(".sidebar-recent-session"),
              group.locator(".sidebar-recent-session"),
            ]) {
              const clearance = await colored.evaluate((row) => {
                const stripe = getComputedStyle(row, "::before");
                return (
                  row.querySelector(".session-glyph")!.getBoundingClientRect().left -
                  row.getBoundingClientRect().left -
                  Number.parseFloat(stripe.left) -
                  Number.parseFloat(stripe.width)
                );
              });
              // Pinned rows center the glyph in a narrower lead than grouped rows.
              expect(clearance).toBeGreaterThanOrEqual(2);
            }
            const header = group.locator(".sidebar-recent-sessions__head");
            const [handle, lead] = await Promise.all([
              header.locator(".sidebar-session-group-drag-handle").boundingBox(),
              header.locator(".sidebar-session-group-toggle__lead").boundingBox(),
            ]);
            expect(handle!.x + handle!.width).toBeLessThanOrEqual(lead!.x);
          }
          const toggle = group.locator(".sidebar-session-group-toggle");
          await toggle.click();
          await group.locator(".sidebar-recent-session").waitFor({ state: "hidden" });
          await toggle.click();
          await group.locator(".sidebar-recent-session").waitFor();
        },
      );
    },
  );

  it.each(["coarse", "fine"] as const)(
    "keeps mobile sidebar titles and menus usable with a %s pointer",
    async (pointer) => {
      const sessionKey = "agent:main:mobile-sidebar-menu";
      const plainKey = "agent:main:mobile-sidebar-long-title";
      const privateKey = "agent:main:mobile-sidebar-private";
      const context = await suite.browser.newContext({
        colorScheme: "dark",
        hasTouch: pointer === "coarse",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 650, width: 390 },
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
      });
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Mobile sidebar menu", Date.parse("2026-08-19T03:00:00.000Z"), {
              category: "Research",
              lastMessagePreview: "Keep this second line visible during navigation",
            }),
            sessionRow(plainKey, "Investigate mobile sidebar title readability", 1),
            sessionRow(privateKey, "Private planning and follow-up tasks", 0, { incognito: true }),
          ]),
        },
        sessionGroups: [
          "Research",
          "Operations",
          "Planning",
          ...Array.from({ length: 24 }, (_, index) => `Team ${index + 1}`),
        ],
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const drawerToggle = page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first();
        await drawerToggle.waitFor({ state: "visible", timeout: 10_000 });
        await drawerToggle.click();
        await waitForMobileSidebarDrawerOpen(page);

        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.locator(".sidebar-recent-session__subtitle").waitFor({ state: "visible" });
        expect(await row.getAttribute("class")).not.toContain(
          "sidebar-recent-session--single-line",
        );
        const title = row.locator(".sidebar-recent-session__name");
        const titleWidth = () => title.evaluate((element) => element.getBoundingClientRect().width);
        const restingWidth = await titleWidth();
        // Keep the drawer increase modest; reclaim reading space inside its rows.
        const drawerBox = await page.locator(".shell-nav").boundingBox();
        expect(drawerBox?.width).toBeGreaterThanOrEqual(330);
        expect(drawerBox?.width).toBeLessThanOrEqual(336);
        // Desktop-sized glyph spacing keeps the color stripe clear without losing the menu.
        expect(restingWidth).toBeGreaterThanOrEqual(230);
        const plainRow = page.locator(`[data-session-key="${plainKey}"]`);
        const plainTitle = plainRow.locator(".sidebar-recent-session__name");
        await plainTitle.waitFor({ state: "visible" });
        expect(
          await plainTitle.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeCloseTo(restingWidth, 1);
        expect(await plainRow.locator(".sidebar-recent-session__details").isVisible()).toBe(false);
        await page
          .locator(`[data-session-key="${privateKey}"] .session-row-badge--incognito`)
          .waitFor({ state: "visible" });
        if (pointer === "fine") {
          await row.hover();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
          await page.mouse.move(389, 649);
          await row.locator(".sidebar-recent-session__link").focus();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
        }
        expect(await row.locator("[data-sidebar-session-pin]").isVisible()).toBe(false);
        expect(await row.locator("[data-sidebar-session-archive]").isVisible()).toBe(false);
        const menuButton = row.locator("[data-sidebar-session-menu]");
        const buttonBox = await menuButton.boundingBox();
        const rowBox = await row.boundingBox();
        if (!buttonBox || !rowBox) {
          throw new Error("expected visible sidebar row and menu target");
        }
        // Allow only roundoff from the drawer's translated box coordinates.
        expect(buttonBox.width).toBeCloseTo(44, 4);
        expect(buttonBox.height).toBeCloseTo(44, 4);
        expect(buttonBox.y).toBeGreaterThanOrEqual(rowBox.y);
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
        if (pointer === "coarse") {
          await menuButton.tap();
        } else {
          await menuButton.click();
        }

        const menu = page.getByRole("menu", { name: "Actions for Mobile sidebar menu" });
        await menu.waitFor({ state: "visible" });
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).waitFor();
        await page.getByRole("menuitem", { name: "Archive session", exact: true }).waitFor();
        await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-root.png");

        expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
        await page.getByRole("menuitem", { name: "Move to group" }).click();
        const back = page.getByRole("menuitem", { name: "Back" });
        await back.waitFor({ state: "visible" });
        await page.getByRole("menuitemradio", { name: "Operations" }).waitFor({ state: "visible" });
        expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
        const menuBox = await menu.boundingBox();
        if (!menuBox) {
          throw new Error("expected visible compact sidebar session menu");
        }
        expect(menuBox.x).toBeGreaterThanOrEqual(8);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(382);
        expect(menuBox.y).toBeGreaterThanOrEqual(8);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(642);
        const scroll = await menu.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          };
        });
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        expect(scroll.scrollTop).toBeGreaterThan(0);
        const backBox = await back.boundingBox();
        if (!backBox) {
          throw new Error("expected sticky Back action bounds");
        }
        expect(backBox.y).toBeGreaterThanOrEqual(menuBox.y);
        expect(backBox.y + backBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height);
        await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-group-drilldown.png");
      } catch (error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: "mobile-sidebar-session-menu",
        });
        throw error;
      } finally {
        await context.close();
      }
    },
  );
});
