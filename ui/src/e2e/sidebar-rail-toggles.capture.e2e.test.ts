import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("hides the People shortcut on a solo Gateway and keeps Activity in Pages", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page, { hasMultipleSessionSharingIdentities: false });
        await page.goto(suite.server.baseUrl + "chat");
        await waitForSessionRosterHydration(page);
        const rail = page.locator(".sidebar-rail");
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [rail], {
            animations: "disabled",
            elements: [rail],
          });
          await writeFile(path.join(suite.artifactDir, "solo-rail.png"), frame.elements[0]!.png);
        }
        expect(await rail.getByRole("button", { name: "People", exact: true }).count()).toBe(0);
        await rail.getByRole("button", { name: "Pages", exact: true }).click();
        await page
          .locator(".sidebar-pages-menu")
          .getByRole("link", { name: "Activity", exact: true })
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/activity");
      },
    );
  });

  it("selects only visible rail panels and restores them without a separate expand button", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page, { hasMultipleSessionSharingIdentities: true });
        await page.goto(`${suite.server.baseUrl}new`);
        const sidebar = page.locator("openclaw-app-sidebar .sidebar-shell");
        const selected = page.locator('[data-navigation-view][aria-pressed="true"]');
        // Rail views never close their own panel; the panel's collapse control does.
        const collapse = page
          .locator("openclaw-app-sidebar")
          .getByRole("button", { name: "Collapse sidebar", exact: true });
        await sidebar.waitFor({ state: "visible" });
        await page.locator('[data-navigation-view="online"]').click();
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        await collapse.click();
        await sidebar.waitFor({ state: "hidden" });
        await page.mouse.move(600, 400);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [page.locator(".sidebar-rail")],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "collapsed-sidebar.png"), frame.png);
        expect(await selected.count()).toBe(0);
        expect(
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).count(),
        ).toBe(0);
        for (const view of ["online", "sessions"]) {
          const button = page.locator('[data-navigation-view="' + view + '"]');
          await button.click();
          await sidebar.waitFor({ state: "visible" });
          await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe(view);
          await collapse.click();
          await sidebar.waitFor({ state: "hidden" });
          await expect.poll(() => selected.count()).toBe(0);
          await expect
            .poll(() => button.evaluate((element) => element === document.activeElement))
            .toBe(true);
        }
        const users = page.locator('[data-navigation-view="online"]');
        await users.click();
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        await users.click();
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        expect(await sidebar.isVisible()).toBe(true);
        await page.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "hidden" });
        await expect.poll(() => selected.count()).toBe(0);
        await expect
          .poll(() => users.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        expect(await sidebar.isVisible()).toBe(true);
        await page.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "hidden" });
        await expect.poll(() => selected.count()).toBe(0);
        // A desktop collapse must not suppress the selected view in an open mobile drawer.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await sidebar.waitFor({ state: "visible" });
        await expect.poll(() => selected.getAttribute("data-navigation-view")).toBe("online");
        await page.locator('[data-navigation-view="online"]').click();
        expect(await sidebar.isVisible()).toBe(true);
      },
    );
  });
});
