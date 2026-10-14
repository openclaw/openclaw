import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Persistent New conversation" });
suite.define(() => {
  it("keeps creation first across views and collapse, then opens the same agent from the mobile drawer", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const dir =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("new-conversation")
            : null;
        await installMockGateway(page, {
          assistantName: "Atlas",
          sessionKey: "agent:main:current",
          sessions: [
            {
              key: "agent:main:current",
              kind: "direct",
              label: "Launch planning",
              updatedAt: 1791871200000,
            },
            {
              key: "agent:main:design",
              kind: "direct",
              label: "Design review",
              updatedAt: 1791871000000,
            },
          ],
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Let's review the launch checklist." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The release notes and design review are ready. What would you like to work on next?",
                },
              ],
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await page
          .locator(".sidebar-recent-session__name")
          .filter({ hasText: "Design review" })
          .waitFor();
        const capture = async (name: string, mobile = false) => {
          if (!dir) {
            return;
          }
          await page.mouse.move(900, 700);
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [composer],
            {
              animations: "disabled",
              elements: mobile ? [] : [page.locator("openclaw-app-sidebar .sidebar")],
            },
          );
          await writeFile(path.join(dir, name + ".png"), frame.png);
          if (frame.elements[0]) {
            await writeFile(path.join(dir, name + "-sidebar.png"), frame.elements[0].png);
          }
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
        await capture("mobile", true);
        expect(await create.isVisible()).toBe(false);
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        await page.locator(".shell--nav-drawer-open").waitFor();
        await create.waitFor();
        if (dir) {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [create], {
            animations: "disabled",
          });
          await writeFile(path.join(dir, "mobile-drawer.png"), frame.png);
        }
        await create.focus();
        await page.keyboard.press("Enter");
        await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=main" });
        await page.locator(".new-session-page__message").waitFor();
        expect(await page.locator(".shell--nav-drawer-open").count()).toBe(0);
      },
    );
  });
});
