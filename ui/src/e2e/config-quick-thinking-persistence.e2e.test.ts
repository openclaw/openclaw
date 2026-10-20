import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  createConfigSuite,
  pageRunner,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

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

function configResponse(
  thinkingDefault: "low" | "high",
  hash: string,
  fastModeDefault?: boolean | "auto",
) {
  const config = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        thinkingDefault,
        ...(fastModeDefault === undefined ? {} : { fastModeDefault }),
      },
    },
  };
  return configSnapshot(config, hash);
}

const modelUrl = () => `${suite.server.baseUrl}settings/model-providers`;
const behavior = (page: Page) => page.locator("#settings-model-behavior");
const radio = (group: ReturnType<typeof behavior>, name: string) =>
  group.getByRole("radio", { name, exact: true });
async function expectChecked(button: ReturnType<typeof radio>) {
  await button.waitFor();
  expect(await button.isChecked()).toBe(true);
}
async function openModels(page: Page) {
  expect((await page.goto(modelUrl()))?.status()).toBe(200);
}
async function installSavingGateway(
  page: Page,
  initial: ReturnType<typeof configResponse>,
  saved: ReturnType<typeof configResponse>,
) {
  return installMockGateway(page, {
    models,
    methodResponses: { "config.get": { sequence: [initial, saved] }, "config.patch": saved },
  });
}
async function reopenModels(context: BrowserContext, saved: ReturnType<typeof configResponse>) {
  const page = await context.newPage();
  await installMockGateway(page, { models, methodResponses: { "config.get": saved } });
  await openModels(page);
  return behavior(page);
}
function expectPatch(
  raw: Record<string, unknown>,
  thinkingDefault: string,
  fastModeDefault: unknown,
) {
  expect(raw).toEqual({
    agents: {
      defaults: { model: "openai/gpt-5.5", utilityModel: null, thinkingDefault, fastModeDefault },
    },
  });
  expect(raw.agents).not.toHaveProperty("defaults.fastMode");
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config mutation params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
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

  it("persists agents.defaults.thinkingDefault through autosave", async () => {
    await withPage(async ({ context, page }) => {
      const savedConfig = configResponse("high", "hash-2");
      const gateway = await installSavingGateway(
        page,
        configResponse("low", "hash-1"),
        savedConfig,
      );
      await openModels(page);
      await expectChecked(radio(behavior(page), "Low"));
      await radio(behavior(page), "High").click();

      const raw = requestRaw(await gateway.waitForRequest("config.patch"));
      expectPatch(raw, "high", null);
      expect(JSON.stringify(raw)).not.toContain("thinkingLevel");
      await expectChecked(radio(await reopenModels(context, savedConfig), "High"));
    });
  });

  it.each([
    { initial: false, initialLabel: "Off", next: true, nextLabel: "On" },
    { initial: true, initialLabel: "On", next: "auto" as const, nextLabel: "Auto" },
    { initial: "auto" as const, initialLabel: "Auto", next: false, nextLabel: "Off" },
  ])(
    "persists agents.defaults.fastModeDefault from $initialLabel to $nextLabel",
    async ({ initial, initialLabel, next, nextLabel }) => {
      await withPage(async ({ context, page }) => {
        const savedConfig = configResponse("low", "hash-2", next);
        const gateway = await installSavingGateway(
          page,
          configResponse("low", "hash-1", initial),
          savedConfig,
        );
        await openModels(page);
        const fastModeGroup = behavior(page).getByRole("radiogroup").nth(1);
        await expectChecked(radio(fastModeGroup, initialLabel));
        await radio(fastModeGroup, nextLabel).click();
        expectPatch(requestRaw(await gateway.waitForRequest("config.patch")), "low", next);
        const persistedGroup = (await reopenModels(context, savedConfig))
          .getByRole("radiogroup")
          .nth(1);
        await expectChecked(radio(persistedGroup, nextLabel));
      });
    },
  );
});
