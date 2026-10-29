import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  objectSchema,
  pageRunner,
} from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings enum controls" });
const withPage = pageRunner(suite, createControlUiE2eContextOptions);

function enumMocks() {
  const config = { laboratory: { choices: ["alpha", "beta"] } };
  const properties = {
    choices: {
      type: "array",
      title: "Unique choices",
      uniqueItems: true,
      items: { type: "string", enum: ["alpha", "beta", "gamma"] },
    },
  };
  return {
    "config.get": configSnapshot(config, "enum-controls", true),
    "config.schema": {
      schema: objectSchema("", {
        laboratory: objectSchema("", properties),
      }),
      uiHints: {},
      version: "enum-controls",
    },
  };
}

suite.define(() => {
  it("restores rejected segmented selections for pointer and keyboard edits", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, { methodResponses: enumMocks() });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
      const second = page.locator('.cfg-array [role="radiogroup"]').nth(1);
      const selected = () =>
        second
          .getByRole("radio", { checked: true })
          .evaluateAll((radios) =>
            radios.map((radio) => radio.closest("label")?.textContent?.trim()),
          );
      await expect.poll(selected).toEqual(["beta"]);
      await second.getByRole("radio", { name: "alpha", exact: true }).click();
      await expect.poll(selected).toEqual(["beta"]);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await second.getByRole("radio", { name: "beta", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect.poll(selected).toEqual(["beta"]);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await second.getByRole("radio", { name: "gamma", exact: true }).click();
      const request = await gateway.waitForRequest("config.set");
      const submitted = JSON.parse((request.params as { raw: string }).raw);
      expect(submitted.laboratory.choices).toEqual(["alpha", "gamma"]);
      await expect.poll(selected).toEqual(["gamma"]);
    });
  });
});
