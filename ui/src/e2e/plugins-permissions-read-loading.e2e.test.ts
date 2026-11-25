import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses, inspection } from "./plugins-settings-admin.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Plugin permissions failed-inspection audit",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not keep the permissions placeholder busy after inspection fails", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1200 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          deferredMethods: ["plugins.inspect"],
          methodResponses: pluginResponses(),
        });
        await page.goto(suite.server.baseUrl + "settings/plugins/workboard?view=settings");
        const surface = page.locator("openclaw-plugins-page");
        const field = surface.getByLabel("Workspace label", { exact: true });
        await field.waitFor();
        const old = await field.elementHandle();
        const value = await field.inputValue();
        const permissions = surface
          .locator(".plugin-editor__section")
          .filter({ has: page.getByRole("heading", { name: "Permissions", exact: true }) });
        const skeleton = permissions.locator(".settings-loading-skeleton");
        await skeleton.waitFor();
        await gateway.rejectDeferred("plugins.inspect", {
          code: "UNAVAILABLE",
          message: "Plugin inspection unavailable",
        });
        const error = surface
          .getByRole("alert")
          .filter({ hasText: "Plugin inspection unavailable" });
        await error.waitFor();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect
          .soft(await skeleton.count(), "failed inspection is not still loading permissions")
          .toBe(0);
        expect(await field.isEnabled()).toBe(true);
        expect(await field.inputValue()).toBe(value);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, surface, [error, field], {
            animations: "disabled",
            scrollTo: surface,
          });
          await writeFile(path.join(suite.artifactDir, "failed-inspection.png"), frame.png);
        }
        const count = (await gateway.getRequests("plugins.inspect")).length;
        await gateway.deferNext("plugins.inspect");
        await error.getByRole("button", { name: "Try again", exact: true }).click();
        await gateway.waitForRequest("plugins.inspect", { after: count });
        expect(await skeleton.count()).toBe(1);
        await gateway.resolveDeferred("plugins.inspect", inspection);
        await surface.getByRole("checkbox", { name: "Modify prompts", exact: true }).waitFor();
        expect(await skeleton.count()).toBe(0);
        expect(await error.count()).toBe(0);
        expect(await field.evaluate((e, previous) => e === previous, old)).toBe(true);
        expect(await field.inputValue()).toBe(value);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      },
    );
  });
  it("does not claim there are no settings before permission inspection succeeds", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const responses = pluginResponses();
        const properties =
          responses["config.schema"].schema.properties.plugins.properties.entries.properties
            .workboard.properties.config.properties;
        for (const key of Object.keys(properties)) {
          Reflect.deleteProperty(properties, key);
        }
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: {
            ...responses,
            "plugins.inspect": {
              __mockError: { code: "UNAVAILABLE", message: "Plugin inspection unavailable" },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/plugins/workboard?view=settings");
        const surface = page.locator("openclaw-plugins-page");
        const error = surface
          .getByRole("alert")
          .filter({ hasText: "Plugin inspection unavailable" });
        await error.waitFor();
        expect
          .soft(
            await surface
              .getByText("This plugin has no configurable settings.", { exact: true })
              .count(),
          )
          .toBe(0);
        await gateway.setMethodResponse("plugins.inspect", inspection);
        await error.getByRole("button", { name: "Try again", exact: true }).click();
        await surface.getByRole("checkbox", { name: "Modify prompts", exact: true }).waitFor();
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      },
    );
  });
});
