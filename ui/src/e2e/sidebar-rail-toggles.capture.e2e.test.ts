import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("selects only visible rail panels and restores them without a separate expand button", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        const sidebar = page.locator("openclaw-app-sidebar .sidebar-shell");
        const selected = page.locator('[data-navigation-view][aria-pressed="true"]');
        const pages = page.locator('[data-navigation-view="pages"]');
        await sidebar.waitFor({ state: "visible" });
        await pages.click();
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("pages");
        await pages.click();
        await sidebar.waitFor({ state: "hidden" });
        await page.mouse.move(600, 400);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [page.locator(".sidebar-rail"), page.locator(".new-session-page__message")],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "collapsed-sidebar.png"), frame.png);
        expect(await selected.count()).toBe(0);
        expect(
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).count(),
        ).toBe(0);
        for (const view of ["pages", "sessions", "online"]) {
          const button = page.locator('[data-navigation-view="' + view + '"]');
          await button.click();
          await sidebar.waitFor({ state: "visible" });
          await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe(view);
          await button.click();
          await sidebar.waitFor({ state: "hidden" });
          await expect.poll(() => selected.count()).toBe(0);
          await expect
            .poll(() => button.evaluate((element) => element === document.activeElement))
            .toBe(true);
        }
        await page.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        await pages.click();
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("pages");
        expect(await sidebar.isVisible()).toBe(true);
        await page.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "hidden" });
        await expect.poll(() => selected.count()).toBe(0);
        // A desktop collapse must not suppress the selected view in an open mobile drawer.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("pages");
        await pages.click();
        expect(await sidebar.isVisible()).toBe(true);
      },
    );
  });
});
