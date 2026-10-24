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
  const config = {
    laboratory: {
      choices: ["alpha", "beta"],
      requiredMode: null,
      optionalMode: null,
      unionMode: null,
      largeMode: null,
    },
  };
  const nullableMode = (title: string, values: (string | null)[] = ["fixed", "other", null]) => ({
    title,
    type: ["string", "null"],
    enum: values,
  });
  const largeValues = ["fixed", "other", "third", "fourth", "fifth", "sixth", null];
  const properties = {
    choices: {
      type: "array",
      title: "Unique choices",
      uniqueItems: true,
      items: { type: "string", enum: ["alpha", "beta", "gamma"] },
    },
    requiredMode: nullableMode("Required mode"),
    optionalMode: nullableMode("Optional mode"),
    unionMode: {
      title: "Union mode",
      anyOf: [{ const: "fixed" }, { const: "other" }, { type: "null" }],
    },
    largeMode: nullableMode("Large mode", largeValues),
  };
  return {
    "config.get": configSnapshot(config, "enum-controls", true),
    "config.schema": {
      schema: objectSchema("", {
        laboratory: objectSchema("", properties, { required: ["requiredMode"] }),
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

  it("round-trips explicit null separately from unset through analyzed enum fields", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, { methodResponses: enumMocks() });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
      await page.getByRole("combobox", { name: "Required mode", exact: true }).waitFor();

      for (const [name, key] of [
        ["Required mode", "requiredMode"],
        ["Optional mode", "optionalMode"],
        ["Union mode", "unionMode"],
        ["Large mode", "largeMode"],
      ] as const) {
        const field = page.getByRole("combobox", { name, exact: true });
        await expect.poll(() => field.count()).toBe(1);
        expect(await field.inputValue()).toBe("__null__");
        const before = (await gateway.getRequests("config.set")).length;
        await field.selectOption({ label: "fixed" });
        await gateway.waitForRequest("config.set", { after: before });
        await expect.poll(() => field.isEnabled()).toBe(true);
        await field.selectOption("__null__");
        const restored = await gateway.waitForRequest("config.set", { after: before + 1 });
        const submitted = JSON.parse((restored.params as { raw: string }).raw);
        expect(submitted.laboratory[key]).toBeNull();
        await expect.poll(() => field.isEnabled()).toBe(true);
      }
      const required = page.getByRole("combobox", { name: "Required mode", exact: true });
      expect(await required.locator('option[value="__unset__"]').isDisabled()).toBe(true);
      const optional = page.getByRole("combobox", { name: "Optional mode", exact: true });
      const before = (await gateway.getRequests("config.set")).length;
      await optional.selectOption("__unset__");
      const cleared = await gateway.waitForRequest("config.set", { after: before });
      const submitted = JSON.parse((cleared.params as { raw: string }).raw);
      expect(submitted.laboratory).not.toHaveProperty("optionalMode");
    });
  });

  it("names the message-width textbox with its visible setting title", async () => {
    await withPage(async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const width = page.locator("[data-settings-chat-message-width]");
      await width.waitFor();
      await width.scrollIntoViewIfNeeded();
      const namedWidth = page.getByRole("textbox", { name: "Message width", exact: true });
      await expect.poll(() => namedWidth.count()).toBe(1);
      await namedWidth.fill("64rem");
      await namedWidth.blur();
      await page.reload();
      await expect.poll(() => namedWidth.inputValue()).toBe("64rem");
    });
  });
});
