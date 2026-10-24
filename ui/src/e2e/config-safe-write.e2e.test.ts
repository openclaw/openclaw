import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  objectSchema,
  configSnapshot,
  configSchema,
  pageRunner,
  settingsPageOptions,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";
import { bounds } from "./new-session-page.scenario.test-support.ts";
import { pollText, pollValue } from "./new-session-page.test-support.ts";

const suite = createConfigSuite("Control UI guarded config writes mocked Gateway E2E");

async function installConfig(page: Page, config: Record<string, unknown>, hash: string) {
  return installMockGateway(page, {
    methodResponses: {
      "config.get": configSnapshot(config, hash, true),
      "config.schema": configSchema(
        objectSchema("", {
          laboratory: objectSchema("Safe writes", {
            endpoint: { type: "string", title: "Endpoint" },
          }),
        }),
        { "laboratory.endpoint": { advanced: false } },
      ),
    },
  });
}

async function expectSeparateControls(firstControl: Locator, secondControl: Locator) {
  const [first, second] = await Promise.all([bounds(firstControl), bounds(secondControl)]);
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  expect(width * height).toBe(0);
}

const withPage = pageRunner(suite, () => settingsPageOptions);

suite.define(() => {
  it("keeps reconnect recovery controls focusable and separate from the build link", async () => {
    await withPage(async ({ page }) => {
      const config = { laboratory: { endpoint: "initial-api" } };
      const gateway = await installConfig(page, config, "legacy-raw-hash");

      await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
      const endpoint = page.getByRole("textbox", { name: "Endpoint", exact: true });
      await pollValue(endpoint).toBe("initial-api");
      await endpoint.fill("retained-draft");

      const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configSnapshot(config, "hmac-sha256:v1:opaque-current", true),
      );
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBe(getsBeforeReconnect + 1);
      await pollValue(endpoint).toBe("retained-draft");

      const saveIndicator = page.locator("openclaw-settings-save-indicator");
      await pollText(saveIndicator).toContain("Autosave paused after reconnect");
      const saveButton = saveIndicator.getByRole("button", { name: "Save", exact: true });
      const buildLink = page.locator(".settings-sidebar__footer .sidebar-footer-build");
      await saveButton.focus();
      await expect
        .poll(() => saveButton.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectSeparateControls(saveButton, buildLink);
      expect(await buildLink.textContent()).not.toBe("");

      await page.setViewportSize({ height: 900, width: 1280 });
      await expectSeparateControls(saveButton, buildLink);
    });
  });
});
