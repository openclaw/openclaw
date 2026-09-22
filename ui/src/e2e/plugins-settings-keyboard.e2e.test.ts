import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin settings keyboard dismissal" });

suite.define(() => {
  it.each(["trigger", "item"])(
    "dismisses the settings menu from its %s before leaving the detail",
    async (focus) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: pluginResponses(),
        });
        const settingsUrl = `${suite.server.baseUrl}settings/plugins/workboard?view=settings`;
        await page.goto(settingsUrl);
        const heading = page.getByRole("heading", { name: "Workboard settings", exact: true });
        await heading.waitFor();
        const trigger = page.getByRole("button", { name: "Actions for Workspace label" });
        await trigger.click();
        const item = page.getByRole("menuitem", { name: "Reset value", exact: true });
        await item.waitFor();
        if (focus === "trigger") {
          await trigger.focus();
        } else {
          await item.focus();
        }
        await page.keyboard.press("Escape");
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `escape-${focus}.png`),
            animations: "disabled",
            caret: "hide",
          });
        }
        expect(page.url()).toBe(settingsUrl);
        await expect.poll(() => item.isVisible()).toBe(false);
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        // Once the menu closes, Escape still belongs to the page and returns
        // to the installed list rather than exiting the entire Settings workspace.
        await page.keyboard.press("Escape");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
        await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
      });
    },
  );
  it.each([
    { key: "ArrowUp", typed: "45", expected: 46, finish: "Tab", constraints: {} },
    { key: "ArrowDown", typed: "45", expected: 44, finish: "Escape", constraints: {} },
    { key: "ArrowUp", typed: undefined, expected: 31, finish: "Tab", constraints: {} },
    {
      key: "ArrowUp",
      typed: "58",
      expected: 60,
      finish: "Tab",
      constraints: { multipleOf: 2, maximum: 60 },
    },
    {
      key: "ArrowDown",
      typed: "2",
      expected: 0,
      finish: "Tab",
      constraints: { multipleOf: 2, minimum: 0 },
    },
  ])(
    "steps the inherited number from $typed with $key and saves on $finish",
    async ({ key, typed, expected, finish, constraints }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const responses = structuredClone(pluginResponses());
        const initial = responses["config.get"].config;
        Reflect.deleteProperty(initial.plugins.entries.workboard.config, "refreshMinutes");
        responses["config.get"].raw = JSON.stringify(initial);
        Object.assign(
          responses["config.schema"].schema.properties.plugins.properties.entries.properties
            .workboard.properties.config.properties.refreshMinutes,
          { default: 30, ...constraints },
        );
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: responses,
        });
        const settingsUrl = `${suite.server.baseUrl}settings/plugins/workboard?view=settings`;
        await page.goto(settingsUrl);
        const number = page.getByRole("spinbutton", {
          name: "Refresh interval (minutes)",
          exact: true,
        });
        await expect.poll(() => number.inputValue()).toBe("30");
        if (typed !== undefined) {
          await number.fill(typed);
        }
        await number.press(key);
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `number-${key}-${typed ?? "default"}.png`),
            animations: "disabled",
            caret: "hide",
          });
        }
        expect(await number.inputValue()).toBe(String(expected));
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await number.press(finish);
        const save = await gateway.waitForRequest("config.set");
        const saved = JSON.parse(String((save.params as { raw?: unknown }).raw));
        expect(saved).toEqual({
          ...initial,
          plugins: {
            ...initial.plugins,
            entries: {
              workboard: {
                ...initial.plugins.entries.workboard,
                config: { ...initial.plugins.entries.workboard.config, refreshMinutes: expected },
              },
            },
          },
        });
        expect(save.params).toMatchObject({ baseHash: "plugins-settings-e2e" });
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        await gateway.setMethodResponse("config.get", {
          ...responses["config.get"],
          config: saved,
          raw: JSON.stringify(saved),
          hash: "numeric-saved",
          appliedConfigHash: "numeric-saved",
        });
        await page.goto(settingsUrl);
        await expect.poll(() => number.inputValue()).toBe(String(expected));
        await page.reload();
        await expect.poll(() => number.inputValue()).toBe(String(expected));
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      });
    },
  );
});
