// Control UI tests cover form support for transform-backed config fields.

import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  objectSchema,
  configSchema,
  pageRunner,
  configProof,
  settingsPageOptions,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI config form guidance mocked Gateway E2E");

const proof = configProof("config-form-guidance");

function notificationStatusConfigMocks() {
  const config = { ui: { prefs: { theme: "claw" } } };
  return {
    "config.get": configSnapshot(config, "notification-status-e2e", true),
    "config.schema": configSchema(
      objectSchema("", {
        ui: objectSchema("UI", {
          prefs: objectSchema("Prefs", { theme: { type: "string", title: "Theme" } }),
        }),
      }),
      { "ui.prefs.theme": { advanced: false } },
    ),
  };
}

const withPage = pageRunner(suite, settingsPageOptions);

const capture = proof.capture;

suite.define(() => {
  it("renders every accepted branch of a transform input schema", async () => {
    await withPage(async ({ page }) => {
      const config = { meta: { groupPolicy: "allowlist" } };
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "config-form-guidance-e2e"),
          "config.schema": configSchema(
            objectSchema("", {
              meta: objectSchema("Meta", {
                groupPolicy: {
                  title: "Group policy",
                  anyOf: [
                    { type: "string", enum: ["open", "allowlist", "disabled"] },
                    { type: "string", const: "allowall" },
                  ],
                },
              }),
            }),
          ),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/advanced`);
      expect(response?.status()).toBe(200);

      await page.getByRole("button", { name: "Core" }).click();
      await page.getByRole("button", { name: "Meta", exact: true }).click();

      const policyRow = page.locator(".settings-row").filter({ hasText: "Group policy" });
      await expect.poll(() => policyRow.getByRole("radio").count()).toBe(4);
      await expect.poll(() => policyRow.getByText("open", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("allowlist", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("disabled", { exact: true }).count()).toBe(1);
      await expect.poll(() => policyRow.getByText("allowall", { exact: true }).count()).toBe(1);
      await expect
        .poll(() => page.getByText("Unsupported schema node. Use Raw mode.").count())
        .toBe(0);
      await expect
        .poll(() => page.locator(".config-content-callout .callout.info").count())
        .toBe(0);

      await capture(page, "01-transform-field-supported.png", true);

      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await expect.poll(() => page.locator(".config-raw-field textarea").count()).toBe(1);
      await expect
        .poll(() => page.locator(".config-content-callout .callout.info").count())
        .toBe(0);
    });
  });

  it("keeps the one advanced disclosure browser-local", async () => {
    await withPage(async ({ page }) => {
      const config = { ui: { prefs: { theme: "claw" } } };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "advanced-disclosure-e2e", true),
          "config.schema": configSchema(
            objectSchema("", {
              ui: objectSchema("UI", {
                seamColor: { type: "string", title: "Accent Color" },
                prefs: objectSchema("Prefs", {
                  theme: { type: "string", title: "Theme" },
                  sidebarEntries: {
                    type: "array",
                    title: "Sidebar Entries",
                    items: { type: "string" },
                  },
                }),
              }),
            }),
            {
              "ui.prefs.theme": { advanced: false },
              "ui.prefs.sidebarEntries": { advanced: true },
              "ui.seamColor": { advanced: true },
            },
          ),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await page.getByRole("tab", { name: "UI", exact: true }).click();

      const disclosure = page.locator("details.config-advanced-disclosure");
      await expect.poll(() => disclosure.count()).toBe(1);
      await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
      await expect
        .poll(() => disclosure.locator(":scope > summary").textContent())
        .toContain("Advanced settings");
      await expect
        .poll(() => page.getByText("Show Advanced Settings", { exact: true }).count())
        .toBe(0);

      await capture(page, "02-advanced-collapsed.png", true);

      await disclosure.locator(":scope > summary").click();
      await expect.poll(() => disclosure.getAttribute("open")).not.toBeNull();

      await capture(page, "03-advanced-expanded.png", true);

      await disclosure.locator(":scope > summary").click();
      await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
      await page.waitForTimeout(750);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await capture(page, "04-advanced-collapsed-final.png", true);
    });
  });

  it("keeps a settled autosave quiet on Notifications", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: notificationStatusConfigMocks(),
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await page.getByRole("tab", { name: "UI", exact: true }).click();

      const themeInput = page
        .locator(".settings-row")
        .filter({ hasText: "Theme" })
        .locator("input.settings-input");
      await expect.poll(() => themeInput.count()).toBe(1);
      await themeInput.fill("knot");
      await gateway.waitForRequest("config.set");
      await page.getByRole("button", { name: "Apply changes", exact: true }).click();
      await gateway.waitForRequest("config.apply");

      await page.getByRole("link", { name: "Notifications", exact: true }).click();
      await page.getByRole("heading", { name: "Push notifications", exact: true }).waitFor();

      const section = page.locator("#settings-communications-notifications");
      await expect.poll(() => page.locator(".config-toolbar").count()).toBe(0);
      await expect.poll(() => page.getByText("Saved", { exact: true }).count()).toBe(0);
      await expect
        .poll(() => section.locator(".settings-section__header .settings-status").count())
        .toBe(1);
      await expect
        .poll(() => section.locator(".settings-section__header").textContent())
        .toContain("Ready");

      await capture(page, "05-notifications-ready-aligned.png", true);
    });
  });
});
