import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin navigation" });

async function checkNavigation({ page }: { page: Page }, admin: boolean) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const revisionOne = heading("Fixture revision one");
  const plugins = heading("Plugins");
  const customize = heading("Customize UI");
  await page.goto(`${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`);
  await revisionOne.waitFor();
  const sidebar = page.locator("openclaw-app-sidebar");
  const pagesButton = sidebar
    .locator(".sidebar-rail")
    .getByRole("button", { name: "Pages", exact: true });
  await pagesButton.click();
  const pages = sidebar.locator(".sidebar-pages");
  const pluginLink = pages.getByRole("link", { name: "UI fixture", exact: true });
  await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
  const builtInLink = pages.getByRole("link", { name: "Plugins", exact: true });
  const selected = async (active: boolean, navigation: Promise<unknown>) => {
    await navigation;
    await (active ? revisionOne : plugins).waitFor();
    await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe(active ? "page" : null);
  };
  const measureWidth = (link: typeof pluginLink) =>
    link.evaluate((element) => element.getBoundingClientRect().width);
  await expect
    .poll(async () => {
      const [width, builtInWidth] = await Promise.all([
        measureWidth(pluginLink),
        measureWidth(builtInLink),
      ]);
      return Math.abs(width - builtInWidth);
    })
    .toBeLessThan(0.5);
  expect(await customize.count()).toBe(0);
  await selected(false, builtInLink.click());
  await selected(true, pluginLink.click());
  await selected(false, page.goBack());
  await selected(true, page.goForward());
  await page.goto(`${suite.server.baseUrl}plugin?p.filter=review&id=proof&plugin=ui-fixture`);
  await revisionOne.waitFor();
  await pagesButton.click();
  await expect.poll(() => pluginLink.getAttribute("aria-current")).toBe("page");
  await selected(false, builtInLink.click());
  expect(await customize.count()).toBe(0);
  await page.goto(`${suite.server.baseUrl}settings/plugins?tab=advanced`);
  await plugins.waitFor();
  await gateway.waitForRequest("plugins.controlUi.report");
  expect(pageErrors).toEqual([]);
  if (!admin) {
    expect(await customize.count()).toBe(0);
    return;
  }
  await page.locator("openclaw-plugin-manager .settings-group").waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  await gateway.setMethodResponse("plugins.controlUi.list", catalog("two"));
  await button("Reload plugin UI").click();
  await gateway.waitForRequest("plugins.controlUi.reload");
  await button("Back to app").click();
  await pagesButton.click();
  await pluginLink.click();
  await heading("Fixture revision two").waitFor();
  expect(pageErrors).toEqual([]);
}

suite.define(() => {
  it.each([true, false])(
    "updates native page selection and keeps reload in Plugins Advanced (admin: %s)",
    (admin) =>
      suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        (fixture) => checkNavigation(fixture, admin),
      ),
  );
});
