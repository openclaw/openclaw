import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Persistent New conversation" });
suite.define(() => {
  it("keeps creation first across views and collapse, then opens the same agent from the mobile drawer", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          assistantName: "Atlas",
          sessionKey: "agent:main:current",
          sessions: (
            [
              ["current", "Launch planning", 1791871200000],
              ["design", "Design review", 1791871000000],
            ] as const
          ).map(([id, label, updatedAt]) => ({
            key: `agent:main:${id}`,
            kind: "direct",
            label,
            updatedAt,
          })),
          historyMessages: [
            ["user", "Let's review the launch checklist."],
            [
              "assistant",
              "The release notes and design review are ready. What would you like to work on next?",
            ],
          ].map(([role, text]) => ({ role, content: [{ type: "text", text }] })),
        });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await page
          .locator(".sidebar-recent-session__name")
          .filter({ hasText: "Design review" })
          .waitFor();
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          await page.mouse.move(900, 700);
          await captureSidebarUiProof(suite, page, `${name}.png`);
        };
        const rail = page.locator("openclaw-app-sidebar .sidebar-rail");
        const create = rail.getByRole("link", { name: "New conversation", exact: true });
        await create.waitFor();
        const initial = await create.boundingBox();
        const avatar = rail.locator(".sidebar-agent-card__main");
        const avatarBox = await avatar.boundingBox();
        const pagesBox = await rail.locator('[data-navigation-view="pages"]').boundingBox();
        expect(initial).not.toBeNull();
        expect(initial!.y).toBeGreaterThan(avatarBox!.y + avatarBox!.height);
        expect(initial!.y + initial!.height).toBeLessThan(pagesBox!.y);
        await avatar.focus();
        await page.keyboard.press("Tab");
        expect(await create.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await create.getAttribute("href")).toBe("/new?agent=main");
        await create.blur();
        await capture("expanded");
        for (const view of ["pages", "online", "sessions"]) {
          await rail.locator('[data-navigation-view="' + view + '"]').click();
          expect(await create.boundingBox()).toEqual(initial);
          expect(await page.locator(".sidebar-session-toolbar .sidebar-new-session").count()).toBe(
            0,
          );
        }
        await page.locator('[data-navigation-view="sessions"]').click();
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await create.boundingBox()).toEqual(initial);
        expect(await page.locator(".shell-chrome-controls__new-thread").count()).toBe(0);
        await capture("collapsed");
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("mobile");
        // The closed drawer stays mounted for its slide animation.
        const nav = page.locator(".shell-nav");
        await expect.poll(() => nav.getAttribute("aria-hidden")).toBe("true");
        expect(await nav.getAttribute("inert")).not.toBeNull();
        expect(await nav.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
          "none",
        );
        await expect
          .poll(() => nav.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(0);
        await navigationDrawerToggle(page).click();
        await page.locator(".shell--nav-drawer-open").waitFor();
        await create.waitFor();
        await captureSidebarUiProof(suite, page, "mobile-drawer.png");
        await create.focus();
        await page.keyboard.press("Enter");
        await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=main" });
        await page.locator(".new-session-page__message").waitFor();
        expect(await page.locator(".shell--nav-drawer-open").count()).toBe(0);
      },
    );
  });
});
