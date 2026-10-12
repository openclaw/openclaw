import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  captureControlUiE2eFailureDiagnostics,
  createControlUiMockSameOriginGatewayScript,
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
    "keeps shortcut menus, colored session glyphs, and section labels usable in a %s pointer layout",
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
          const gateway = await installMockGateway(page, {
            sessionKey: groupedKey,
            sessionGroups: ["Research", "Operations"],
            sessions: [
              sessionRow(pinnedKey, "Release planning", 3, {
                icon: "📌",
                color: "blue",
              }),
              sessionRow(groupedKey, "Review the mobile navigation changes", 2, {
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
          // This suite serves Vite source; bind it to the same Gateway origin as the seed.
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          await page.addInitScript(
            ({ key, gatewayUrl }) => {
              localStorage.setItem(`openclaw.control.currentGateway.v1:${gatewayUrl}`, gatewayUrl);
              localStorage.setItem(
                key,
                JSON.stringify({
                  sidebarEntries: [
                    "route:cron",
                    "session:agent:main:release-plan",
                    "plugin:reports/reports",
                  ],
                }),
              );
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
            },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, groupedKey));
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
          await waitForMobileSidebarDrawerOpen(page);
          const rail = page.locator(".sidebar-rail");
          const pinned = rail.locator('[data-sidebar-entry="session:agent:main:release-plan"]');
          const plugin = rail.locator('[data-sidebar-entry="plugin:reports/reports"]');
          const session = page.locator(
            '.sidebar-session-content .sidebar-recent-session[data-session-key="agent:main:release-plan"]',
          );
          const group = page.locator('[data-session-section="category:Research"]');
          await pinned.locator(".session-glyph").waitFor();
          await plugin.locator(".nav-item__icon").waitFor();
          await group.locator(".sidebar-recent-session").waitFor();
          await session.waitFor();
          // Pins are flat navigation refs, while session actions stay in Sessions.
          expect(await pinned.locator(".sidebar-recent-session").count()).toBe(0);
          await rail.locator('[data-navigation-view="pages"]').click();
          await page
            .locator('.sidebar-pages [data-sidebar-entry="plugin:reports/reports"]')
            .waitFor();
          expect(await plugin.count()).toBe(1);
          await rail.locator('[data-navigation-view="sessions"]').click();
          await group.locator(".sidebar-recent-session").waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell-nav"),
              [pinned, plugin, group],
              { animations: "disabled", elements: [page.locator(".shell-nav")] },
            );
            await writeFile(
              path.join(suite.artifactDir, "sidebar-spacing-" + pointer + ".png"),
              frame.png,
            );
            await writeFile(
              path.join(suite.artifactDir, "sidebar-spacing-" + pointer + "-crop.png"),
              frame.elements[0]!.png,
            );
          }
          if (pointer === "coarse") {
            await page.clock.install();
          }
          for (const width of [320, 390, 768]) {
            await page.setViewportSize({ width, height: 844 });
            expect((await rail.boundingBox())?.width).toBe(52);
            for (const row of [pinned, plugin]) {
              const shortcut = row.getByRole("link");
              await row.hover();
              const [button, glyph] = await Promise.all([
                shortcut.boundingBox(),
                row.locator(".session-glyph, .nav-item__icon").first().boundingBox(),
              ]);
              expect(await row.locator(".sidebar-reorder-trigger").count()).toBe(0);
              expect(button).not.toBeNull();
              expect(glyph).not.toBeNull();
              expect(button!.width).toBeGreaterThanOrEqual(32);
              expect(button!.height).toBeGreaterThanOrEqual(32);
              expect(glyph!.x).toBeGreaterThanOrEqual(button!.x);
              expect(glyph!.x + glyph!.width).toBeLessThanOrEqual(button!.x + button!.width);
              expect(glyph!.y).toBeGreaterThanOrEqual(button!.y);
              expect(glyph!.y + glyph!.height).toBeLessThanOrEqual(button!.y + button!.height);
              if (width === 390) {
                const previous = await row.evaluate((element) =>
                  element.previousElementSibling?.getAttribute("data-sidebar-entry"),
                );
                expect(previous).not.toBeNull();
                if (pointer === "coarse") {
                  const touch = {
                    pointerId: 1,
                    pointerType: "touch",
                    isPrimary: true,
                    clientX: button!.x + button!.width / 2,
                    clientY: button!.y + button!.height / 2,
                  };
                  const initialUrl = page.url();
                  await shortcut.dispatchEvent("pointerdown", touch);
                  await page.clock.fastForward(500);
                  await page.getByRole("menuitem", { name: "Move up", exact: true }).waitFor();
                  await shortcut.dispatchEvent("pointerup", touch);
                  await shortcut.dispatchEvent("click", { ...touch, detail: 1 });
                  expect(page.url()).toBe(initialUrl);
                  await waitForMobileSidebarDrawerOpen(page);
                } else {
                  await shortcut.focus();
                  await page.keyboard.press("Shift+F10");
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
            const menuBox = await session.locator("[data-sidebar-session-menu]").boundingBox();
            const sessionBox = await session.boundingBox();
            expect(menuBox).not.toBeNull();
            expect(sessionBox).not.toBeNull();
            expect(menuBox!.x).toBeGreaterThanOrEqual(sessionBox!.x);
            expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
              sessionBox!.x + sessionBox!.width,
            );
            expect(menuBox!.width).toBe(44);
            for (const colored of [session, group.locator(".sidebar-recent-session")]) {
              const clearance = await colored.evaluate((row) => {
                const stripe = getComputedStyle(row, "::before");
                return (
                  row.querySelector(".session-glyph")!.getBoundingClientRect().left -
                  row.getBoundingClientRect().left -
                  Number.parseFloat(stripe.left) -
                  Number.parseFloat(stripe.width)
                );
              });
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
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
          expect(await gateway.getRequests("config.patch")).toEqual([]);
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
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell-nav"),
            [title],
            {
              animations: "disabled",
              elements: [page.locator(".shell-nav")],
            },
          );
          await writeFile(path.join(suite.artifactDir, `mobile-title-${pointer}.png`), frame.png);
          await writeFile(
            path.join(suite.artifactDir, `mobile-title-${pointer}-crop.png`),
            frame.elements[0]!.png,
          );
        }
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
        const titleBox = await title.boundingBox();
        if (!buttonBox || !rowBox || !titleBox) {
          throw new Error("expected visible sidebar row and menu target");
        }
        // Allow only roundoff from the drawer's translated box coordinates.
        expect(buttonBox.width).toBeCloseTo(44, 4);
        expect(buttonBox.height).toBeCloseTo(44, 4);
        expect(titleBox.x).toBeGreaterThanOrEqual(rowBox.x);
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
        expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(buttonBox.y);
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

  it.each([1280, 390])(
    "shows everyday actions and the advanced page at width %i",
    async (width) => {
      await suite.withPage(
        { colorScheme: "dark", hasTouch: width === 390, viewport: { width, height: 900 } },
        async ({ page, context }) => {
          const sessionKey = "agent:main:release-checklist";
          await installMockGateway(page, {
            sessionKey,
            featureMethods: [
              "chat.startup",
              "sessions.assignOwner",
              "sessions.setInvolvement",
              "sessions.create",
              "sessions.patch",
              "users.list",
            ],
            sessionGroups: ["Product", "Research"],
            hasMultipleSessionSharingIdentities: true,
            operatorScopes: ["operator.read", "operator.write", "operator.admin"],
            presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
            sessions: [
              sessionRow(sessionKey, "Release checklist", Date.now() - 300_000, {
                hiddenFromInvolvingMe: false,
                owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
                effectiveCommunication: { send: "always", receive: "ask" },
              }),
              sessionRow("agent:main:design-review", "Design review", Date.now() - 600_000),
              sessionRow("agent:main:customer-notes", "Customer notes", Date.now() - 900_000),
            ],
            historyMessages: [
              { role: "user", content: "What is left before the release?" },
              {
                role: "assistant",
                content:
                  "The implementation is ready. Next: review the changes, verify the checklist, and publish the release notes.",
              },
            ],
            methodResponses: {
              "users.list": {
                profiles: ["Ada", "Ben"].map((name) => ({
                  id: "profile-" + name.toLowerCase(),
                  displayName: name,
                  emails: [],
                  mergedInto: null,
                  avatarMime: null,
                  hasAvatar: false,
                  githubIdentity: null,
                  createdAt: 1,
                  updatedAt: 1,
                })),
              },
            },
          });
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          if (width === 390) {
            await page
              .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
              .first()
              .click();
            await waitForMobileSidebarDrawerOpen(page);
          }
          const row = page.locator('[data-session-key="' + sessionKey + '"]');
          await row.locator(".sidebar-recent-session__link").click({ button: "right" });
          const menu = page.locator("openclaw-session-menu");
          await menu.getByRole("menuitem", { name: "Pin session", exact: true }).waitFor();
          const phase = "after-" + width;
          expect(
            await menu
              .locator(":scope > wa-dropdown > wa-dropdown-item > .session-menu__text")
              .allTextContents(),
          ).toEqual([
            "Pin session",
            "Rename…",
            "Mark as unread",
            "Copy link",
            "Assign to…",
            "Move to group",
            "Snooze",
            "Archive session",
            "Advanced",
          ]);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [menu.getByRole("menuitem", { name: "Pin session", exact: true })],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, phase + "-root.png"), frame.png);
          }
          await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
          await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await row.locator(".sidebar-recent-session__link").click({ button: "right" });
          await menu.getByRole("menuitem", { name: "Assign to…", exact: true }).click();
          await menu.getByRole("menuitemradio", { name: "Ben", exact: true }).waitFor();
          if (width === 390) {
            expect(await menu.locator("[slot='submenu']").count()).toBe(0);
            await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
            await menu.getByRole("menuitem", { name: "Copy link", exact: true }).waitFor();
          } else {
            await page.keyboard.press("ArrowLeft");
          }
          const advanced = menu.getByRole("menuitem", {
            name: "Advanced",
            exact: true,
          });
          await advanced.click();
          await menu.getByRole("button", { name: "Ask", exact: true }).first().waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [
                width === 390
                  ? menu.getByRole("menuitem", { name: "Back", exact: true })
                  : advanced,
                menu.locator(".session-menu__communication"),
              ],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, phase + "-advanced.png"), frame.png);
          }
          if (width === 390) {
            for (const label of ["Copy details", "Open in", "Icon & color"]) {
              await menu.getByRole("menuitem", { name: label, exact: true }).click();
              expect(await menu.locator("[slot='submenu']").count()).toBe(0);
              await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
              await menu.getByRole("button", { name: "Ask", exact: true }).first().waitFor();
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [menu.getByRole("menuitem", { name: "Back", exact: true })],
              { animations: "disabled" },
            );
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              await writeFile(path.join(suite.artifactDir, "after-phone-back.png"), frame.png);
            }
            await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
            await menu.getByRole("menuitem", { name: "Copy link", exact: true }).waitFor();
          }
        },
      );
    },
  );
});
