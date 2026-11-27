import { expect } from "playwright/test";
import { it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createNativeEmbedLayoutMethodResponses } from "./native-embed-fixtures.test-support.ts";
import { installNativeEmbed } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Search model field layout" });
suite.define(() => {
  it.each(["web", "embedded"] as const)(
    "aligns both edges of the model and agent fields on a %s phone",
    async (surface) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, hasTouch: true },
        async ({ page }) => {
          if (surface === "embedded") {
            await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
          }
          const methodResponses = createNativeEmbedLayoutMethodResponses();
          await installMockGateway(page, { methodResponses });
          await page.goto(new URL("settings/search", suite.server.baseUrl).href);
          const agent = page.getByRole("combobox", { name: "Agent", exact: true });
          const model = page.locator("openclaw-search-page .model-picker .picker-select__trigger");
          await expect(agent).toBeVisible();
          await expect(model).toContainText("Agent default");
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const agentBox = (await agent.boundingBox())!;
          const modelBox = (await model.boundingBox())!;
          expect(modelBox.x).toBeCloseTo(agentBox.x, 0);
          expect(modelBox.x + modelBox.width).toBeCloseTo(agentBox.x + agentBox.width, 0);
          await model.tap({ position: { x: modelBox.width - 10, y: modelBox.height / 2 } });
          const choices = page.getByRole("listbox");
          await expect(choices).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(choices).not.toBeVisible();
          await expect(model).toBeFocused();
        },
      );
    },
  );
});
