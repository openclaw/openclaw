import { writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community card E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const dismissalKey = "openclaw:control-ui:community-invite:v2";
const sessions = Array.from({ length: 32 }, (_, index) =>
  createControlUiSessionRow(
    index === 0 ? "agent:main:main" : `agent:main:task-${index}`,
    index === 0 ? "Home" : `Project task ${index}`,
    1792411200000 - index * 60000,
  ),
);

suite.define(() => {
  for (const mobile of [false, true]) {
    for (const mode of ["light", "dark"] as const) {
      it(`keeps the ${mobile ? "mobile" : "desktop"} ${mode} card flush and dismissal persistent`, async () => {
        await suite.withPage(
          {
            viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
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
            const url = controlUiSessionUrl(suite.server.baseUrl, "agent:main:main");
            await page.goto(url);
            if (mobile) {
              await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
              await waitForMobileSidebarDrawerOpen(page);
            }
            const card = page.locator(".community-invite-card");
            const close = card.getByRole("button", { name: "Dismiss and don't show again" });
            await close.waitFor();
            const closeAppearance = await close.evaluate((node) => {
              const target = node.getBoundingClientRect();
              const backdrop = getComputedStyle(node, "::before");
              const header = node.closest(".invite__header")!.getBoundingClientRect();
              const glyph = node.querySelector("svg")!.getBoundingClientRect();
              const backdropInset = (Number.parseFloat(backdrop.width) - glyph.width) / 2;
              return {
                targetWidth: target.width,
                targetHeight: target.height,
                background: getComputedStyle(node).backgroundColor,
                backdropWidth: Number.parseFloat(backdrop.width),
                backdropHeight: Number.parseFloat(backdrop.height),
                visibleTop: glyph.top - header.top - backdropInset,
                visibleRight: header.right - glyph.right - backdropInset,
                contained:
                  target.left >= header.left &&
                  target.top >= header.top &&
                  target.right <= header.right &&
                  target.bottom <= header.bottom,
              };
            });
            expect(closeAppearance.background).toBe("rgba(0, 0, 0, 0)");
            expect(closeAppearance.visibleTop).toBeCloseTo(8, 0);
            expect(closeAppearance.visibleRight).toBeCloseTo(8, 0);
            expect(closeAppearance.contained).toBe(true);
            expect(closeAppearance.backdropWidth).toBeLessThanOrEqual(24);
            expect(closeAppearance.backdropHeight).toBeLessThanOrEqual(24);
            expect(closeAppearance.targetWidth).toBeGreaterThanOrEqual(mobile ? 44 : 24);
            expect(closeAppearance.targetHeight).toBeGreaterThanOrEqual(mobile ? 44 : 24);
            const shell = page.locator(".sidebar-shell");
            const list = page.locator(".sidebar-shell__body");
            const cardBounds = (await card.boundingBox())!;
            const shellBounds = (await shell.boundingBox())!;
            const listBounds = (await list.boundingBox())!;
            expect(cardBounds.x).toBeCloseTo(shellBounds.x, 0);
            expect(cardBounds.width).toBeCloseTo(shellBounds.width, 0);
            expect(cardBounds.y + cardBounds.height).toBeCloseTo(
              shellBounds.y + shellBounds.height,
              0,
            );
            expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(cardBounds.y);
            expect(listBounds.height).toBeGreaterThan(120);
            const artwork = card.locator(".invite__art");
            await expect
              .poll(() =>
                artwork.evaluate(
                  (node) =>
                    node instanceof HTMLImageElement && node.complete && node.naturalWidth === 1024,
                ),
              )
              .toBe(true);
            expect(await artwork.getAttribute("src")).toContain(`community-invite-${mode}.webp`);
            const artworkBounds = (await artwork.boundingBox())!;
            expect(artworkBounds.height).toBeGreaterThan(80);
            expect(cardBounds.height - artworkBounds.height).toBeLessThan(190);
            expect(
              await card
                .locator(".invite__body")
                .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
            ).toBeGreaterThanOrEqual(12);
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(page, shell, [card, close], {
                elements: [page.locator(".sidebar"), card],
                animations: "disabled",
              });
              const name = `after-${mobile ? "mobile" : "desktop"}-${mode}`;
              await writeFile(nodePath.join(suite.artifactDir, name + ".png"), frame.png);
              await writeFile(
                nodePath.join(suite.artifactDir, name + "-sidebar.png"),
                frame.elements[0]!.png,
              );
              await writeFile(
                nodePath.join(suite.artifactDir, name + "-card.png"),
                frame.elements[1]!.png,
              );
            }
            for (let index = 0; index < 3; index += 1) {
              await page.getByRole("button", { name: "Show more", exact: true }).click();
            }
            await page.setViewportSize(
              mobile ? { width: 390, height: 568 } : { width: 1280, height: 540 },
            );
            await page.locator('[data-session-key="agent:main:task-31"]').scrollIntoViewIfNeeded();
            expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
            const shortListBounds = (await list.boundingBox())!;
            const shortCardBounds = (await card.boundingBox())!;
            expect(shortListBounds.height).toBeGreaterThan(80);
            expect(shortListBounds.y + shortListBounds.height).toBeLessThanOrEqual(
              shortCardBounds.y,
            );
            expect(shortCardBounds.y + shortCardBounds.height).toBeLessThanOrEqual(
              mobile ? 568 : 540,
            );
            await page.setViewportSize(
              mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
            );
            await list.evaluate((node) => {
              node.scrollTop = 0;
            });
            await page.locator('.sidebar-rail [data-navigation-view="pages"]').click();
            await close.waitFor();
            await page.locator('.sidebar-rail [data-navigation-view="sessions"]').click();
            await page.keyboard.press("Tab");
            await close.focus();
            expect(await close.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
            expect(
              await close.evaluate((node) => getComputedStyle(node, "::before").outlineStyle),
            ).toBe("solid");
            if (mobile && mode === "light") {
              await close.tap({ position: { x: 2, y: 2 } });
            } else {
              await page.keyboard.press("Enter");
            }
            await card.waitFor({ state: "detached" });
            expect(
              await page.evaluate((key) => localStorage.getItem(key), dismissalKey),
            ).not.toBeNull();
            expect(
              await page
                .locator('.sidebar-rail [data-navigation-view="sessions"]')
                .evaluate((node) => node === document.activeElement),
            ).toBe(true);
            await page.goto(`${suite.server.baseUrl}new`);
            await page
              .locator('.sidebar-rail [data-navigation-view="sessions"]')
              .waitFor({ state: "attached" });
            expect(await card.count()).toBe(0);
            await page.goto(url);
            await page
              .locator('.sidebar-rail [data-navigation-view="sessions"]')
              .waitFor({ state: "attached" });
            expect(await card.count()).toBe(0);
            await page.reload();
            if (mobile) {
              await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
            }
            await page.locator(".sidebar-shell").waitFor();
            expect(await card.count()).toBe(0);
            await page.setViewportSize(
              mobile ? { width: 1280, height: 700 } : { width: 390, height: 568 },
            );
            if (!mobile) {
              await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
            }
            await page.locator(".sidebar-shell").waitFor();
            expect(await card.count()).toBe(0);
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              await page.setViewportSize(
                mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
              );
              if (mobile) {
                const toggle = page.getByRole("button", { name: "Expand sidebar", exact: true });
                if (await toggle.isVisible()) {
                  await toggle.click();
                }
              }
              const sidebar = page.locator(".sidebar");
              const frame = await takeControlUiScreenshotFrame(page, sidebar, [list], {
                elements: [sidebar],
                animations: "disabled",
              });
              await writeFile(
                nodePath.join(
                  suite.artifactDir,
                  `dismissed-${mobile ? "mobile" : "desktop"}-${mode}.png`,
                ),
                frame.png,
              );
            }
          },
        );
      });
    }
  }

  it("honors earlier dismissals and deployment policy when re-enabled", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { communityInvite: true });
      await page.addInitScript((key) => localStorage.setItem(key, "dismissed"), dismissalKey);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.locator(".sidebar-shell").waitFor();
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), communityInvite: false },
        }),
      );
      await page.reload();
      await page.locator(".sidebar-shell").waitFor();
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({ json: { ...createControlUiMockBootstrapConfig(), communityInvite: true } }),
      );
      await page.reload();
      await page.locator(".sidebar-shell").waitFor();
      expect(await page.locator(".community-invite-card").count()).toBe(0);
    });
  });
});
