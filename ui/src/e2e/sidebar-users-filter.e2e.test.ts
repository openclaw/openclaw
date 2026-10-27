import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar user filter",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps people counts at the edge and personal actions in one accessible menu", () =>
    suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.write"],
          presenceUsers: ["Ada Chen", "Bob Rivera", "Jacqueline Henriksen"].map((name, index) => ({
            id: ["ada", "bob", "jacqueline"][index]!,
            identity: { type: "profile", id: ["ada", "bob", "jacqueline"][index]! },
            name,
            self: index === 0,
          })),
          methodResponses: {
            "sessions.list": {
              ...sessionsListResponse([]),
              ownerSessionCounts: [
                { profileId: "ada", open: 33, running: 11 },
                { profileId: "bob", open: 17, running: 8 },
                { profileId: "jacqueline", open: 15, running: 0 },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator('[data-navigation-view="online"]').click();
        const person = page.locator('[data-online-user-id="ada"]');
        const row = person.locator("..");
        const counts = person.locator(".sidebar-online__counts");
        await counts.waitFor();
        await page.mouse.move(900, 600);
        const capture = async (name: string, content = counts) => {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".sidebar"),
            [person, content],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        await capture("people-light-rest");
        const bounds = async () => ({
          row: await row.boundingBox(),
          counts: await counts.boundingBox(),
        });
        const rest = await bounds();
        expect(
          rest.row!.x + rest.row!.width - rest.counts!.x - rest.counts!.width,
        ).toBeLessThanOrEqual(10);
        const more = row.getByRole("button", { name: "Actions for Ada Chen", exact: true });
        expect(await more.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe("0");
        await person.hover();
        await more.click();
        const menu = page.getByRole("menu", { name: "Actions for Ada Chen", exact: true });
        await menu.waitFor();
        expect((await bounds()).counts).toEqual(rest.counts);
        expect(await page.locator(".person-activity-hovercard").count()).toBe(0);
        await capture("people-light-menu", menu);
        await menu.getByRole("menuitem", { name: "Pin to sidebar", exact: true }).click();
        const shortcut = page.locator('[data-sidebar-entry="person:ada"]');
        await shortcut.waitFor();
        await page.reload();
        await page.locator('[data-navigation-view="online"]').click();
        await person.waitFor();
        await shortcut.waitFor();
        await person.click({ button: "right" });
        await menu.getByRole("menuitem", { name: "Unpin from sidebar", exact: true }).click();
        await expect.poll(() => shortcut.count()).toBe(0);
        await person.focus();
        await page.keyboard.press("Shift+F10");
        await menu.waitFor();
        const href = await person.getAttribute("href");
        const newTab = menu.getByRole("menuitem", {
          name: "Open activity in new tab",
          exact: true,
        });
        expect(await newTab.getAttribute("href")).toBe(href);
        expect(await newTab.getAttribute("target")).toBe("_blank");
        const [popup] = await Promise.all([page.waitForEvent("popup"), newTab.click()]);
        await expect.poll(() => new URL(popup.url()).pathname).toBe(href);
        await popup.close();
        await menu.getByRole("menuitem", { name: "Copy activity link", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(new URL(href!, page.url()).href);
        await person.click({ button: "right" });
        await menu.waitFor();
        await page.keyboard.press("Escape");
        await expect.poll(() => menu.isVisible()).toBe(false);
        expect(await person.evaluate((el) => el === document.activeElement)).toBe(true);
        await more.click();
        await page.mouse.click(900, 600);
        await expect.poll(() => menu.isVisible()).toBe(false);
        await person.click({ button: "right" });
        await menu.getByRole("menuitem", { name: "View activity", exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(href);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      },
    ));

  it("keeps person actions visible on touch without opening the activity hovercard", () =>
    suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        hasTouch: true,
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          presenceUsers: [
            { id: "ada", identity: { type: "profile", id: "ada" }, name: "Ada Chen", self: true },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator('[data-navigation-view="online"]').tap();
        const person = page.locator('[data-online-user-id="ada"]');
        const more = person
          .locator("..")
          .getByRole("button", { name: "Actions for Ada Chen", exact: true });
        await more.waitFor();
        expect(await more.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe("1");
        expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(40);
        await more.tap();
        const menu = page.getByRole("menu", { name: "Actions for Ada Chen", exact: true });
        await menu.waitFor();
        expect(await page.locator(".person-activity-hovercard").count()).toBe(0);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".sidebar"),
          [person, menu],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "people-dark-touch-menu.png"), frame.png);
        await menu.getByRole("menuitem", { name: "Pin to sidebar", exact: true }).tap();
        await page.locator('[data-sidebar-entry="person:ada"]').waitFor();
      },
    ));

  it("filters connected and offline profiles without collapsing the Users view", () =>
    suite.withPage(
      { colorScheme: "dark", locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["users.list"],
          operatorScopes: ["operator.read", "operator.write"],
          presenceUsers: ["Ada Chen", "Bob Rivera"].map((name, index) => ({
            id: index === 0 ? "ada" : "bob",
            identity: { type: "profile", id: index === 0 ? "ada" : "bob" },
            name,
            self: index === 0 ? true : undefined,
            lastInputSeconds: index === 0 ? 5 : 180,
          })),
          methodResponses: {
            "users.list": {
              profiles: ["Ada Chen", "Bob Rivera", "Carol Singh"].map((displayName, index) => ({
                id: ["ada", "bob", "carol"][index],
                displayName,
                avatarMime: null,
                mergedInto: null,
                createdAt: 1,
                updatedAt: 1,
                emails: [],
                githubIdentity: null,
                hasAvatar: false,
              })),
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const rail = page.locator('[data-navigation-view="online"]');
        await rail.click();
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
        const dismissHovercard = async () => {
          await page.mouse.move(900, 400);
          await expect.poll(() => page.locator(".person-activity-hovercard").count()).toBe(0);
          await page
            .locator(".sidebar-online__person-name")
            .getByText("Ada Chen", { exact: true })
            .waitFor();
        };
        await dismissHovercard();
        expect(await rail.getAttribute("aria-label")).toBe("Users");
        await rail.click();
        await expect.poll(() => rail.getAttribute("aria-pressed")).toBe("true");
        const choosePresence = async (value: "all" | "online") => {
          await page.locator("#sidebar-people-presence").click();
          await page
            .locator(`openclaw-select-picker:has(#sidebar-people-presence) [data-value="${value}"]`)
            .click();
        };
        await choosePresence("all");
        await gateway.waitForRequest("users.list");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(3);
        expect(
          await page.locator('[data-online-user-id="carol"]').getAttribute("aria-description"),
        ).toContain("Offline");
        await dismissHovercard();
        await choosePresence("online");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
      },
    ));
});
