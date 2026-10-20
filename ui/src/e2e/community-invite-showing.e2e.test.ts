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
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community entry E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (path) => `Playwright Chromium is unavailable at ${path}`,
});

suite.define(() => {
  it("keeps the mobile entry compact and opens a sheet without changing the selected session", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        await installMockGateway(page, { communityInvite: true });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:control-ui:community-invite:v2", "dismissed");
        });
        const artworkRequests: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes("/community-art/")) {
            artworkRequests.push(request.url());
          }
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        const entry = page.getByRole("button", { name: "Community", exact: true });
        await entry.waitFor({ state: "visible" });
        const bounds = await entry.boundingBox();
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeLessThanOrEqual(48);
        expect(await page.locator(".sidebar-community-dialog").count()).toBe(0);
        expect(artworkRequests).toEqual([]);
        const selectedUrl = page.url();
        await entry.tap();
        const dialog = page.getByRole("dialog", { name: "Community", exact: true });
        await dialog.waitFor({ state: "visible" });
        await page.locator('.sidebar-community-dialog dialog[data-phase="open"]').waitFor();
        const sheetBounds = await dialog.boundingBox();
        expect(sheetBounds?.width).toBe(390);
        expect(Math.round((sheetBounds?.y ?? 0) + (sheetBounds?.height ?? 0))).toBe(844);
        await page.getByRole("button", { name: "Close", exact: true }).tap();
        await dialog.waitFor({ state: "detached" });
        expect(page.url()).toBe(selectedUrl);
        expect(await entry.isVisible()).toBe(true);
      },
    );
  });

  it("keeps Community in the rail without shortening the session list and honors policy reloads", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { communityInvite: false });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.locator("openclaw-app-sidebar").waitFor();
      expect(await page.locator(".sidebar-community__entry").count()).toBe(0);
      const listHeight = (await page.locator(".sidebar-shell__body").boundingBox())!.height;
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), communityInvite: true },
        }),
      );
      await page.reload();
      const entry = page.getByRole("button", { name: "Community", exact: true });
      await entry.waitFor({ state: "visible" });
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const sidebar = page.locator(".sidebar");
        const frame = await takeControlUiScreenshotFrame(page, sidebar, [entry], {
          elements: [sidebar],
          animations: "disabled",
        });
        await writeFile(
          nodePath.join(suite.artifactDir, "community-sidebar.png"),
          frame.elements[0]!.png,
        );
      }
      expect(await entry.evaluate((node) => Boolean(node.closest(".sidebar-rail")))).toBe(true);
      expect((await page.locator(".sidebar-shell__body").boundingBox())!.height).toBe(listHeight);
      const selectedUrl = page.url();
      await page.locator('.sidebar-rail [data-navigation-view="sessions"]').click();
      await expect.poll(() => page.locator(".sidebar-shell").isVisible()).toBe(false);
      expect(await entry.isVisible()).toBe(true);
      await entry.click();
      const dialog = page.getByRole("dialog", { name: "Community", exact: true });
      await dialog.waitFor({ state: "visible" });
      await page.locator('.sidebar-community-dialog dialog[data-phase="open"]').waitFor();
      expect((await dialog.boundingBox())?.width).toBe(400);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await entry.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(page.url()).toBe(selectedUrl);
    });
  });
});
