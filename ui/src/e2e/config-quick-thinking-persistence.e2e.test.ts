import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  createConfigSuite,
  pageRunner,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createConfigSuite(
  "Control UI Models settings behavior persistence mocked Gateway E2E",
);
const withPage = pageRunner(suite, createControlUiE2eContextOptions);
const models = [
  {
    id: "gpt-5.5",
    name: "gpt-5.5",
    provider: "openai",
    reasoning: true,
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    supportsFastMode: true,
    serviceTiers: ["priority"],
  },
];
type Field = "thinkingDefault" | "fastModeDefault";
type Value = "low" | "high" | boolean | "auto";
const defaultsFor = (field: Field, value: Value) => ({ thinkingDefault: "low", [field]: value });
function configResponse(field: Field, value: Value, hash: string) {
  const defaults = defaultsFor(field, value);
  return configSnapshot({ agents: { defaults: { model: "openai/gpt-5.5", ...defaults } } }, hash);
}
const modelUrl = () => `${suite.server.baseUrl}settings/model-providers`;
const group = (page: Page, fast: boolean) => {
  const card = page.locator("#settings-model-behavior");
  return fast ? card.getByRole("radiogroup").nth(1) : card;
};
const radio = (container: Locator, name: string) =>
  container.getByRole("radio", { name, exact: true });
async function expectChecked(button: Locator) {
  await button.waitFor();
  expect(await button.isChecked()).toBe(true);
}

suite.define(() => {
  it("redirects the legacy General model deep link to Models", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page);
      const response = await page.goto(
        `${suite.server.baseUrl}settings/general#settings-general-model`,
      );
      expect(response?.status()).toBe(200);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });

  it.each([
    ["thinkingDefault", "low", "high", "Low", "High"],
    ["fastModeDefault", false, true, "Off", "On"],
    ["fastModeDefault", true, "auto", "On", "Auto"],
    ["fastModeDefault", "auto", false, "Auto", "Off"],
  ] satisfies [Field, Value, Value, string, string][])(
    "persists %s from %s to %s through autosave",
    async (field, initial, saved, from, to) => {
      await withPage(async ({ context, page }) => {
        const fast = field === "fastModeDefault";
        const savedConfig = configResponse(field, saved, "hash-2");
        const gateway = await installMockGateway(page, {
          models,
          methodResponses: {
            "config.get": { sequence: [configResponse(field, initial, "hash-1"), savedConfig] },
            "config.patch": savedConfig,
          },
        });
        expect((await page.goto(modelUrl()))?.status()).toBe(200);
        await expectChecked(radio(group(page, fast), from));
        await radio(group(page, fast), to).click();
        const raw = requestRaw(await gateway.waitForRequest("config.patch"));
        expect(raw).toEqual({
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
              utilityModel: null,
              fastModeDefault: null,
              ...defaultsFor(field, saved),
            },
          },
        });
        expect(raw.agents).not.toHaveProperty("defaults.fastMode");
        if (!fast) {
          expect(JSON.stringify(raw)).not.toContain("thinkingLevel");
        }
        const fresh = await context.newPage();
        await installMockGateway(fresh, { models, methodResponses: { "config.get": savedConfig } });
        expect((await fresh.goto(modelUrl()))?.status()).toBe(200);
        await expectChecked(radio(group(fresh, fast), to));
      });
    },
  );
});
