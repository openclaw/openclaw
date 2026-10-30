import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin settings keyboard dismissal" });
const viewport = { width: 1280, height: 900 };
const settingsUrl = () => `${suite.server.baseUrl}settings/plugins/workboard?view=settings`;

async function openSettings(page: Page, responses = pluginResponses()) {
  const gateway = await installMockGateway(page, {
    operatorScopes: ["operator.read", "operator.admin"],
    methodResponses: responses,
  });
  await page.goto(settingsUrl());
  return gateway;
}

suite.define(() => {
  it("lets the Settings sidebar clear its search without closing plugin details", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openSettings(page);
      await page.locator(".plugin-editor").waitFor();
      const search = page.locator(".settings-sidebar__search-input");
      await search.fill("appearance");
      await search.press("Escape");
      expect(page.url()).toBe(settingsUrl());
      expect(await search.inputValue()).toBe("");
      expect(await page.locator(".plugin-editor").isVisible()).toBe(true);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await search.blur();
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
    });
  });

  it.each(["trigger", "item"])(
    "dismisses the settings menu from its %s before leaving the detail",
    async (focus) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await openSettings(page);
        const search = page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true });
        await search.waitFor();
        const trigger = page.getByRole("button", { name: "Actions for Workspace label" });
        await trigger.click();
        const item = page.getByRole("menuitem", { name: "Reset value", exact: true });
        await item.waitFor();
        await (focus === "trigger" ? trigger : item).focus();
        await page.keyboard.press("Escape");
        expect(page.url()).toBe(settingsUrl());
        await expect.poll(() => item.isVisible()).toBe(false);
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        await page.keyboard.press("Escape");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
        await page.getByRole("heading", { level: 1, name: "Plugins", exact: true }).waitFor();
      });
    },
  );
  it.each([
    ["ArrowUp", "45", 46, "Tab", {}],
    ["ArrowDown", "45", 44, "Escape", {}],
    ["ArrowUp", undefined, 31, "Tab", {}],
    ["ArrowUp", "58", 60, "Tab", { multipleOf: 2, maximum: 60 }],
    ["ArrowDown", "2", 0, "Tab", { multipleOf: 2, minimum: 0 }],
  ] as const)(
    "steps the inherited number with %s from %s to %s and saves on %s",
    async (key, typed, expected, finish, constraints) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const responses = structuredClone(pluginResponses());
        const initial = responses["config.get"].config;
        Reflect.deleteProperty(initial.plugins.entries.workboard.config, "refreshMinutes");
        responses["config.get"].raw = JSON.stringify(initial);
        Object.assign(
          responses["config.schema"].schema.properties.plugins.properties.entries.properties
            .workboard.properties.config.properties.refreshMinutes,
          { default: 30, ...constraints },
        );
        const gateway = await openSettings(page, responses);
        const number = page.getByRole("spinbutton", {
          name: "Refresh interval (minutes)",
          exact: true,
        });
        await expect.poll(() => number.inputValue()).toBe("30");
        if (typed !== undefined) {
          await number.fill(typed);
        }
        await number.press(key);
        expect(await number.inputValue()).toBe(String(expected));
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await number.press(finish);
        const save = await gateway.waitForRequest("config.set");
        const saved = JSON.parse(String((save.params as { raw?: unknown }).raw));
        const expectedConfig = structuredClone(initial);
        expectedConfig.plugins.entries.workboard.config.refreshMinutes = expected;
        expect(saved).toEqual(expectedConfig);
        expect(save.params).toMatchObject({ baseHash: "plugins-settings-e2e" });
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        await gateway.setMethodResponse("config.get", {
          ...responses["config.get"],
          config: saved,
          raw: JSON.stringify(saved),
          hash: "numeric-saved",
          appliedConfigHash: "numeric-saved",
        });
        await page.goto(settingsUrl());
        await expect.poll(() => number.inputValue()).toBe(String(expected));
        await page.reload();
        await expect.poll(() => number.inputValue()).toBe(String(expected));
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      });
    },
  );
});
