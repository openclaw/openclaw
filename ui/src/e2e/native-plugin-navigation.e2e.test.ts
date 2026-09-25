import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin navigation" });

suite.define(() => {
  it.each([true, false])(
    "updates native page selection and keeps reload on Plugins (admin: %s)",
    async (admin) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            operatorScopes: admin ? ["operator.admin"] : ["operator.read"],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "plugins.controlUi.list",
              "plugins.controlUi.report",
              "plugins.controlUi.reload",
            ],
            methodResponses: {
              "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: admin },
              "plugins.controlUi.list": catalog("one"),
              "plugins.controlUi.report": { ok: true },
              "plugins.controlUi.reload": catalog("two"),
            },
          });
          await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
            route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: pluginModule(new URL(route.request().url()).pathname.split("/").at(-2)!, false),
            }),
          );
          await page.goto(`${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`);
          await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
          const pluginLink = page.getByRole("link", { name: "UI fixture", exact: true });
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
          const builtInLink = page.getByRole("link", { name: "Plugins", exact: true });
          await expect
            .poll(async () => {
              const width = await pluginLink.evaluate((link) => link.getBoundingClientRect().width);
              const builtInWidth = await builtInLink.evaluate(
                (link) => link.getBoundingClientRect().width,
              );
              return Math.abs(width - builtInWidth);
            })
            .toBeLessThan(0.5);
          expect(
            await page.getByRole("button", { name: "Customize UI", exact: true }).count(),
          ).toBe(0);
          await page.getByRole("link", { name: "Plugins", exact: true }).click();
          await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBeNull();
          await pluginLink.click();
          await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
          await page.goBack();
          await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBeNull();
          await page.goForward();
          await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
          await page.goto(
            `${suite.server.baseUrl}plugin?p.filter=review&id=proof&plugin=ui-fixture`,
          );
          await page.getByRole("heading", { name: "Fixture revision one" }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
          await page.getByRole("link", { name: "Plugins", exact: true }).click();
          await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
          await expect.poll(() => pluginLink.getAttribute("aria-current")).toBeNull();
          if (!admin) {
            expect(
              await page.getByRole("button", { name: "Customize UI", exact: true }).count(),
            ).toBe(0);
            return;
          }
          await page.getByRole("button", { name: "Customize UI", exact: true }).click();
          await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
          await page.getByRole("button", { name: "Reload plugin UI", exact: true }).click();
          await gateway.waitForRequest("plugins.controlUi.reload");
          await page.getByRole("button", { name: "Close", exact: true }).last().click();
          await page.getByRole("link", { name: "UI fixture", exact: true }).click();
          await page.getByRole("heading", { name: "Fixture revision two" }).waitFor();
        },
      );
    },
  );
});
