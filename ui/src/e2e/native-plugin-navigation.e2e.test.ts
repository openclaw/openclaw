import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureNativePluginUiProof,
  catalog,
  pluginModule,
} from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin navigation selection" });

async function expectSelection(page: Page, selected: string | null) {
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(
        document.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
          "openclaw-plugin-contributions",
        ),
        (element) => element.updateComplete,
      ),
    );
  });
  for (const label of ["UI fixture", "Secondary fixture"]) {
    const link = page.getByRole("link", { name: label, exact: true });
    expect(await link.getAttribute("aria-current"), label).toBe(selected === label ? "page" : null);
    expect(
      await link.evaluate((element) => element.classList.contains("nav-item--active")),
      label,
    ).toBe(selected === label);
  }
}

suite.define(() => {
  it.each(["chat", "plugin"])(
    "updates selection across routes and history from %s",
    async (initial) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const first = catalog("one");
        const second = {
          ...catalog("two").plugins[0],
          pluginId: "ui-secondary",
          name: "Secondary fixture",
          entryUrl: "/__openclaw__/plugins/control-ui/ui-secondary/two/index.js",
        };
        await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": { ...first, plugins: [...first.plugins, second] },
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/*/*/index.js", (route) => {
          const secondary = route.request().url().includes("/ui-secondary/");
          const body = secondary
            ? pluginModule("two", false)
                .replaceAll("ui-fixture", "ui-secondary")
                .replaceAll("UI fixture", "Secondary fixture")
            : pluginModule("one", false);
          return route.fulfill({ status: 200, contentType: "text/javascript", body });
        });
        const chatUrl = controlUiSessionUrl(suite.server.baseUrl, "agent:main:main");
        await page.goto(
          initial === "chat" ? chatUrl : `${suite.server.baseUrl}plugin?plugin=ui-fixture&id=proof`,
        );
        await page.getByRole("link", { name: "Secondary fixture", exact: true }).waitFor();
        if (initial === "chat") {
          await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          await expectSelection(page, null);
          await page.getByRole("link", { name: "UI fixture", exact: true }).click();
        }
        await page.getByRole("heading", { name: "Fixture revision one", exact: true }).waitFor();
        await captureNativePluginUiProof(suite, page, `${initial}-plugin.png`);
        await expectSelection(page, "UI fixture");
        await page
          .locator(`a[href="${new URL(chatUrl).pathname}"]`)
          .first()
          .click();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await composer.fill("Synthetic navigation proof");
        await captureNativePluginUiProof(suite, page, `${initial}-chat.png`);
        await expectSelection(page, null);
        await page.getByRole("link", { name: "UI fixture", exact: true }).click();
        await page.getByRole("heading", { name: "Fixture revision one", exact: true }).waitFor();
        await expectSelection(page, "UI fixture");
        await page.getByRole("link", { name: "Secondary fixture", exact: true }).click();
        await page.getByRole("heading", { name: "Fixture revision two", exact: true }).waitFor();
        await expectSelection(page, "Secondary fixture");
        await page.goBack();
        await page.getByRole("heading", { name: "Fixture revision one", exact: true }).waitFor();
        await expectSelection(page, "UI fixture");
        await page.goBack();
        await composer.waitFor();
        await expectSelection(page, null);
        await page.goForward();
        await page.getByRole("heading", { name: "Fixture revision one", exact: true }).waitFor();
        await expectSelection(page, "UI fixture");
        await page.goForward();
        await page.getByRole("heading", { name: "Fixture revision two", exact: true }).waitFor();
        await expectSelection(page, "Secondary fixture");
      });
    },
  );
});
