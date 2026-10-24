import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("settles a failed config load and reflects the owner's reconnect result", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const config = {
        mcp: { servers: { github: { enabled: true, url: "https://mcp.example.test" } } },
      };
      const loadError = "Configuration unavailable; reconnect to retry.";
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.get"],
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        methodResponses: {
          "config.get": {
            raw: JSON.stringify(config),
            hash: "reconnected-config",
            sourceConfig: config,
            runtimeConfig: config,
            config,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await gateway.waitForRequest("config.get");
      // Hold the next request so an accidental render-driven retry cannot hide behind success.
      await gateway.deferNext("config.get");
      await gateway.rejectDeferred("config.get", {
        code: "UNAVAILABLE",
        message: loadError,
      });

      const composer = page.locator(".new-session-page__composer");
      const message = page.locator(".new-session-page__message");
      await message.fill("Keep this draft after the config error");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      const menu = composer.locator(".agent-chat__capability-menu");
      const search = menu.getByRole("menuitemcheckbox", { name: "Web search" });
      const github = menu.getByRole("menuitemcheckbox", { name: /^github/ });
      await expect.poll(() => search.isVisible()).toBe(true);
      expect(await gateway.getRequests("config.get")).toHaveLength(1);
      expect(await tooltipTitleText(search)).toContain(loadError);

      await page.keyboard.press("Escape");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(1);
      await gateway.resolveDeferred("config.get");
      await composer.getByRole("button", { name: "Add attachment" }).click();
      await menu.getByRole("menuitem", { name: /^Plugins/ }).click();
      await expect.poll(() => github.isEnabled()).toBe(true);
      expect(await message.inputValue()).toBe("Keep this draft after the config error");
    }));
});
