import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSchema,
  configSnapshot,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("effective security exposure");
suite.define(() => {
  it.each([
    {
      status: "failed",
      activeMode: "off",
      label: "This device only",
      reason: "Tailscale Serve is disabled on this tailnet. Enable Serve and restart the Gateway.",
    },
    {
      status: "preserved",
      activeMode: "funnel",
      label: "External Funnel",
      reason:
        "An external Funnel is still active. Only plugin-authenticated webhooks accept it; Gateway-authenticated routes reject it.",
    },
  ] as const)("shows $status Serve activation without claiming active Serve", async (fixture) => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const config = {
          gateway: { bind: "loopback", auth: { mode: "token" }, tailscale: { mode: "serve" } },
        };
        const gateway = await installMockGateway(page, {
          authMode: "token",
          gatewayExposure: {
            bindHost: "127.0.0.1",
            tailscaleMode: fixture.activeMode,
            tailscaleExposure: {
              requestedMode: "serve",
              activeMode: fixture.activeMode,
              status: fixture.status,
              reason: fixture.reason,
            },
          },
          methodResponses: {
            "config.get": configSnapshot(config, "exposure-fixture"),
            "config.schema": configSchema({ type: "object", properties: {} }),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/security");
        await gateway.waitForRequest("config.get");
        const row = page.getByRole("button", { name: /^Network access/ });
        await expect
          .poll(() => row.textContent())
          .toContain(
            fixture.status === "preserved"
              ? "An external Funnel is still active. Only plugin-authenticated webhooks accept it; Gateway-authenticated routes reject it."
              : "Requested Tailscale access is not active.",
          );
        expect(await row.textContent()).toContain(fixture.label);
        await row.focus();
        await expect.poll(() => row.evaluate((node) => node === document.activeElement)).toBe(true);
        await row.hover();
        expect(await row.isVisible()).toBe(true);
      },
    );
  });
});
