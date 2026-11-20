import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Solo sidebar destinations" });

suite.define(() => {
  it("opens Activity and eligible Remote access from Pages without a Users sidebar", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await installNativePluginMockGateway(page, {
          hasMultipleSessionSharingIdentities: false,
          nativePlugins: [
            {
              pluginId: "openclaw-id-access",
              rootDir: path.resolve("extensions/openclaw-id-access"),
              source: "./browser/index.tsx",
            },
          ],
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          methodResponses: {
            "openclawId.status": {
              status: { state: "on" },
              owner: true,
              channel: "local_operator",
              link: { linked: false },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        await waitForControlUiGatewayReady(page);
        const users = page.locator('[data-navigation-view="online"]');
        expect(await users.count()).toBe(0);

        const pages = await openSidebarPages(page);
        await pages.getByRole("link", { name: "Activity", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "activity" });
        expect(await page.locator(".sidebar-online").count()).toBe(0);

        const reopened = await openSidebarPages(page);
        await reopened.getByRole("link", { name: "Remote access", exact: true }).click();
        await page.getByRole("heading", { name: "Remote access", exact: true }).waitFor();
        expect(await page.locator(".sidebar-online").count()).toBe(0);
      },
    );
  });
});
