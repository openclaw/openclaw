import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  await expect.poll(() => button.isChecked()).toBe(true);
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

  it("persists distinct Fast and Ultrafast choices with incomplete speed metadata", async () => {
    await withPage(async ({ context, page }) => {
      const speedModels = [
        {
          ...models[0]!,
          supportsFastMode: undefined,
          available: true,
          serviceTiers: ["ultrafast"],
        },
      ];
      const snapshot = (value: boolean | "ultrafast", hash: string) =>
        configSnapshot(
          {
            agents: {
              defaults: {
                model: "openai/gpt-5.5",
                thinkingDefault: "low",
                fastModeDefault: value,
              },
            },
          },
          hash,
        );
      const gateway = await installMockGateway(page, {
        models: speedModels,
        methodResponses: {
          "config.get": snapshot("ultrafast", "speed-1"),
          "config.patch": snapshot(true, "speed-2"),
        },
      });
      await page.goto(modelUrl());
      const speed = group(page, true);
      await expectChecked(radio(speed, "Ultrafast"));
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const surface = page.locator("#settings-model-behavior");
        const frame = await takeControlUiScreenshotFrame(page, surface, [speed], {
          animations: "disabled",
          scrollTo: surface,
        });
        await writeFile(
          path.join(
            suite.artifactDir,
            `${process.env.OPENCLAW_UI_PROOF_STAGE ?? "after"}-speed.png`,
          ),
          frame.png,
        );
      }
      await gateway.deferNext("config.patch");
      await radio(speed, "Fast").click();
      expect(requestRaw(await gateway.waitForRequest("config.patch"))).toMatchObject({
        agents: { defaults: { fastModeDefault: true } },
      });
      const priorReads = (await gateway.getRequests("config.get")).length;
      // The applied-config refresh must see the same snapshot as the save acknowledgment.
      await gateway.setMethodResponse("config.get", snapshot(true, "speed-2"));
      await gateway.resolveDeferred("config.patch");
      await gateway.waitForRequest("config.get", { after: priorReads });
      await expectChecked(radio(speed, "Fast"));
      await gateway.setMethodResponse("config.patch", snapshot("ultrafast", "speed-3"));
      await gateway.deferNext("config.patch");
      await radio(speed, "Ultrafast").click();
      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(2);
      const requests = await gateway.getRequests("config.patch");
      expect(requestRaw(requests[1]!)).toMatchObject({
        agents: { defaults: { fastModeDefault: "ultrafast" } },
      });
      await gateway.setMethodResponse("config.get", snapshot("ultrafast", "speed-3"));
      await gateway.resolveDeferred("config.patch");
      await expectChecked(radio(speed, "Ultrafast"));
      const fresh = await context.newPage();
      await installMockGateway(fresh, {
        models: speedModels,
        methodResponses: { "config.get": snapshot("ultrafast", "speed-3") },
      });
      await fresh.goto(modelUrl());
      await expectChecked(radio(group(fresh, true), "Ultrafast"));
    });
  });

  it.each([
    ["thinkingDefault", "low", "high", "Low", "High"],
    ["fastModeDefault", false, true, "Off", "Fast"],
    ["fastModeDefault", true, "auto", "Fast", "Auto"],
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
