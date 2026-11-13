import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar Users visibility" });

suite.define(() => {
  it.each([false, true])("shows Users only on multi-user gateways (%s)", async (multipleUsers) => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: multipleUsers,
          presenceUsers: [{ id: "alex", name: "Alex Morgan", self: true }],
        });
        await page.goto(suite.server.baseUrl + "new");
        const sessions = page.locator('[data-navigation-view="sessions"]');
        const users = page.locator('[data-navigation-view="online"]');
        await sessions.waitFor();
        await page.locator(".new-session-page__message").waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await captureFrame(
            suite.artifactDir,
            multipleUsers ? "multi-user.png" : "solo.png",
            page.locator(".shell"),
            [page.locator(".sidebar-rail"), sessions],
          );
        }
        await expect.poll(() => users.count()).toBe(multipleUsers ? 1 : 0);
        if (multipleUsers) {
          await users.click();
          await page.locator('[data-online-user-id="alex"]').waitFor();
          expect(await users.getAttribute("aria-pressed")).toBe("true");
        }
        await page.setViewportSize({ width: 400, height: 820 });
        await navigationDrawerToggle(page).click();
        await sessions.waitFor({ state: "visible" });
        expect(await users.count()).toBe(multipleUsers ? 1 : 0);
      },
    );
  });
});
