import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import { expandSidebarSessions } from "./sidebar-session-pagination.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community card E2E",
  startServerBeforeBrowser: true,
});
const sessions = Array.from({ length: 32 }, (_, index) =>
  createControlUiSessionRow(
    index === 0 ? "agent:main:main" : `agent:main:task-${index}`,
    index === 0 ? "Home" : `Project task ${index}`,
    1792411200000 - index * 60000,
  ),
);

suite.define(() => {
  for (const [mobile, mode] of [
    [false, "dark"],
    [true, "light"],
  ] as const) {
    it(`keeps the compact ${mobile ? "mobile" : "desktop"} card flush and restores focus on dismissal`, async () =>
      suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 568 } : { width: 1280, height: 540 },
          hasTouch: mobile,
          colorScheme: mode,
        },
        async ({ page }) => {
          await seedChatSettings(page, suite.server.baseUrl, {
            themeMode: mode,
            sidebarAgentsMode: "chip",
            navWidth: 320,
          });
          await installMockGateway(page, { communityInvite: true, sessions });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          if (mobile) {
            await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
            await waitForMobileSidebarDrawerOpen(page);
          }
          const card = page.locator(".community-invite-card");
          const close = card.getByRole("button", { name: "Dismiss and don't show again" });
          await close.waitFor();
          // Home is outside the paged task list.
          await expandSidebarSessions(page.locator(".sidebar-shell__body"), sessions.length - 1);
          const list = page.locator(".sidebar-shell__body");
          const lastSession = page.locator('[data-session-key="agent:main:task-31"]');
          await expect
            .poll(async () => {
              await list.evaluate((node) => {
                node.scrollTop = node.scrollHeight;
              });
              return lastSession.isVisible();
            })
            .toBe(true);
          await lastSession.scrollIntoViewIfNeeded();
          const closeAppearance = await close.evaluate((node) => {
            const target = node.getBoundingClientRect();
            const backdrop = getComputedStyle(node, "::before");
            const header = node.closest(".invite__header")!.getBoundingClientRect();
            const glyph = node.querySelector("svg")!.getBoundingClientRect();
            const backdropInset = (Number.parseFloat(backdrop.width) - glyph.width) / 2;
            return {
              targetSize: Math.min(target.width, target.height),
              background: getComputedStyle(node).backgroundColor,
              backdropSize: Math.max(
                Number.parseFloat(backdrop.width),
                Number.parseFloat(backdrop.height),
              ),
              inset: [
                glyph.top - header.top - backdropInset,
                header.right - glyph.right - backdropInset,
              ],
              contained:
                target.left >= header.left &&
                target.top >= header.top &&
                target.right <= header.right &&
                target.bottom <= header.bottom,
            };
          });
          expect(closeAppearance).toMatchObject({
            background: "rgba(0, 0, 0, 0)",
            contained: true,
            inset: [expect.closeTo(8, 0), expect.closeTo(8, 0)],
          });
          expect(closeAppearance.backdropSize).toBeLessThanOrEqual(24);
          expect(closeAppearance.targetSize).toBeGreaterThanOrEqual(mobile ? 44 : 24);
          const cardBounds = (await card.boundingBox())!;
          const shellBounds = (await page.locator(".sidebar-shell").boundingBox())!;
          const listBounds = (await list.boundingBox())!;
          expect(cardBounds.x).toBeCloseTo(shellBounds.x, 0);
          expect(cardBounds.width).toBeCloseTo(shellBounds.width, 0);
          expect(cardBounds.y + cardBounds.height).toBeCloseTo(
            shellBounds.y + shellBounds.height,
            0,
          );
          expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(cardBounds.y);
          expect(listBounds.height).toBeGreaterThan(80);
          expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
          expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(mobile ? 568 : 540);
          const artwork = card.locator(".invite__art");
          await expect
            .poll(() =>
              artwork.evaluate(
                (node) =>
                  node instanceof HTMLImageElement && node.complete && node.naturalWidth === 1024,
              ),
            )
            .toBe(true);
          const artworkBounds = (await artwork.boundingBox())!;
          expect(artworkBounds.height).toBeGreaterThan(80);
          expect(cardBounds.height - artworkBounds.height).toBeLessThan(190);
          expect(
            await card
              .locator(".invite__body")
              .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
          ).toBeGreaterThanOrEqual(12);
          await list.evaluate((node) => {
            node.scrollTop = 0;
          });
          await page.locator('.sidebar-rail [data-navigation-view="pages"]').click();
          await close.waitFor();
          const sessionsRail = page.locator('.sidebar-rail [data-navigation-view="sessions"]');
          await sessionsRail.click();
          await page.keyboard.press("Tab");
          await close.focus();
          expect(await close.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
          expect(
            await close.evaluate((node) => getComputedStyle(node, "::before").outlineStyle),
          ).toBe("solid");
          if (mobile) {
            await close.tap({ position: { x: 2, y: 2 } });
          } else {
            await page.keyboard.press("Enter");
          }
          await card.waitFor({ state: "detached" });
          expect(await sessionsRail.evaluate((node) => node === document.activeElement)).toBe(true);
        },
      ));
  }
});
