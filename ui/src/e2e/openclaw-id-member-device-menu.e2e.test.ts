import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.ts";
import type { OpenClawIdStatusResult } from "../lib/openclaw-id/types.ts";
import {
  createControlUiMockBootstrapConfig,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "OpenClaw ID member device menu" });

suite.define(() => {
  it.each([
    { owner: false, action: "Approve a new device", view: "approve" },
    { owner: false, action: "Your devices", view: "devices" },
    { owner: true, action: "Your devices", view: null },
  ])("opens $action for owner=$owner through the correct device surface", async (test) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const status: OpenClawIdStatusResult = {
        status: { state: "on" },
        channel: "tunnel",
        remoteAccessSetup: null,
        accountSignIn: null,
        owner: test.owner,
        connection: test.owner
          ? { kind: "owner", deviceLabel: "Laptop", ownerAccountId: "synthetic-owner" }
          : {
              kind: "member",
              role: "viewer",
              accountId: "synthetic-member",
              email: "member@example.test",
              displayName: "Member",
            },
        link: { linked: true, hostname: "studio.claws.example.test" },
        services: { issuerUrl: null, discoveryUrl: null, loaderDomain: null },
      };
      const scenario = {
        featureMethods: [...defaultControlUiFeatureMethods, "openclawId.status"],
        methodResponses: {
          "openclawId.status": status,
          "openclawId.people": { link: { ...status.link, ownerDevices: [] } },
        },
      };
      const gateway = await installMockGateway(page, scenario);
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...createControlUiMockBootstrapConfig(scenario),
            openclawIdEnabled: true,
          }),
        }),
      );
      // Only the destination document is a fixture; the menu performs real browser navigation.
      await page.route("**/_loader/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Loader device management</h1>" }),
      );
      await page.goto(new URL("new", suite.server.baseUrl).href);
      await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready);
      const originalUrl = page.url();
      await page.locator("openclaw-app-sidebar:visible .sidebar-identity-card").click();
      const menu = page.locator('.sidebar-identity-menu[data-phase="open"]');
      await menu.getByRole("menuitem", { name: "Your devices", exact: true }).waitFor();
      expect(
        await menu.getByRole("menuitem", { name: "Approve a new device", exact: true }).count(),
      ).toBe(test.owner ? 0 : 1);
      await menu.getByRole("menuitem", { name: test.action, exact: true }).click();
      if (test.owner) {
        await page.getByRole("dialog", { name: "Your devices", exact: true }).waitFor();
        await gateway.waitForRequest("openclawId.people");
        expect(page.url()).toBe(originalUrl);
      } else {
        const destination = new URL(`/_loader/?stay=1&view=${test.view}`, originalUrl).href;
        await page.waitForURL(destination);
        expect(page.url()).toBe(destination);
        await page.getByRole("heading", { name: "Loader device management" }).waitFor();
      }
    });
  });
});
