import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import {
  createConfigSuite,
  configSnapshot,
  settingsPageOptions,
  settingsRow,
} from "./config-composer-fixtures.test-support.ts";
const suite = createConfigSuite("Control UI curated settings defaults mocked Gateway E2E");
const thinkingDefaultExplanation =
  "Uses the selected model's thinking policy instead of saving a global thinking override.";
const fastModeDefaultExplanation =
  "Uses the selected model's fast-mode policy. Unlike Auto, Default does not enable fast mode by itself.";
function configResponse(config: Record<string, unknown>, hash: string) {
  return { ...configSnapshot(config, hash), appliedConfigHash: hash };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config mutation params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

const radio = (row: Locator, name: string | RegExp) =>
  row.getByRole("radio", { name, exact: true });

async function finishPatch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  config: Record<string, unknown>,
  hash: string,
  ok = false,
) {
  const response = configResponse(config, hash);
  await gateway.setMethodResponse("config.get", response);
  await gateway.resolveDeferred("config.patch", ok ? { ok: true, ...response } : response);
}

async function expectQuietDefault(row: Locator) {
  await row.waitFor();
  await expect.poll(() => row.textContent()).not.toContain("Using default:");
}

async function expectDefaultInfo(row: Locator, explanation: string) {
  const info = row
    .locator(".settings-row__title")
    .getByRole("button", { name: /^About (thinking|fast mode) defaults$/u });
  await info.waitFor();
  await expect.poll(() => info.locator("svg").count()).toBe(1);
  const tooltip = info.locator("..");
  const tooltipIsOpen = () =>
    tooltip.locator(".tooltip-surface[popover]").evaluate((node) => node.matches(":popover-open"));
  await info.click();
  await expect.poll(tooltipIsOpen).toBe(true);
  await expect.poll(() => tooltip.textContent()).toContain(explanation);
  await info.press("Escape");
  await expect.poll(tooltipIsOpen).toBe(false);
}

async function expectModelPatch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  after: number,
  fastModeDefault: true | null,
) {
  expect(requestRaw(await gateway.waitForRequest("config.patch", { after }))).toEqual({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        utilityModel: null,
        thinkingDefault: null,
        fastModeDefault,
      },
    },
  });
}

suite.define(() => {
  it("persists Full tools and restores inherited Labs, browser, and Models defaults across reloads", async () => {
    await suite.withPage(settingsPageOptions, async ({ page }) => {
      const initialConfig = {
        agents: {
          defaults: {
            fastModeDefault: true,
            model: "openai/gpt-5.5",
            thinkingDefault: "high",
          },
        },
        browser: { enabled: false },
        tools: {
          codeMode: { enabled: "auto" },
          profile: "minimal",
        },
      };
      const afterLabsReset = {
        agents: initialConfig.agents,
        browser: initialConfig.browser,
        tools: { codeMode: {}, profile: "minimal" },
      };
      const afterThinkingReset = {
        agents: {
          defaults: {
            fastModeDefault: true,
            model: "openai/gpt-5.5",
          },
        },
      };
      const afterModelResets = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse(initialConfig, "curated-defaults-1"),
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
      const codeModeRow = settingsRow(page, "Code Mode");
      const codeModeSwitch = codeModeRow.getByRole("switch", { name: "Code Mode", exact: true });
      await codeModeSwitch.waitFor();
      expect(await codeModeSwitch.isChecked()).toBe(true);
      await expect.poll(() => codeModeRow.textContent()).toContain("Default: Disabled");

      const configGetsBeforeLabsReset = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.patch");
      await codeModeSwitch.click();
      const labsPatch = requestRaw(await gateway.waitForRequest("config.patch"));
      expect(labsPatch).toEqual({ tools: { codeMode: { enabled: null } } });

      await finishPatch(gateway, afterLabsReset, "curated-defaults-2");
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBe(configGetsBeforeLabsReset + 1);
      await expectQuietDefault(codeModeRow);
      expect(await codeModeSwitch.isChecked()).toBe(false);

      expect((await page.goto(`${suite.server.baseUrl}settings/security`))?.status()).toBe(200);
      const browserRow = settingsRow(page, "Browser enabled");
      const profileRow = settingsRow(page, "Available tools");
      await browserRow.getByRole("switch", { name: "Browser enabled", exact: true }).waitFor();
      await expect.poll(() => browserRow.textContent()).toContain("Default: Enabled");
      expect(await radio(profileRow, "Minimal").isChecked()).toBe(true);
      expect(await profileRow.textContent()).not.toContain("Default: Full");

      const securitySavesBefore = (await gateway.getRequests("config.set")).length;
      await browserRow.locator(".settings-row__title").click();
      await radio(profileRow, "Full").click();
      await expectQuietDefault(browserRow);
      await expect.poll(() => radio(profileRow, "Full").isChecked()).toBe(true);
      expect(await profileRow.textContent()).not.toContain("Using default: Full");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("config.set");
          const latest = requests.at(-1);
          if (requests.length <= securitySavesBefore || !latest) {
            return false;
          }
          const raw = requestRaw(latest);
          return {
            browserEnabledOverridden:
              typeof raw.browser === "object" &&
              raw.browser !== null &&
              !Array.isArray(raw.browser) &&
              Object.hasOwn(raw.browser, "enabled"),
            tools: raw.tools,
          };
        })
        .toMatchObject({ browserEnabledOverridden: false, tools: { profile: "full" } });
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Apply changes");

      expect((await page.reload())?.status()).toBe(200);
      await expectQuietDefault(settingsRow(page, "Browser enabled"));
      const reloadedProfileRow = settingsRow(page, "Available tools");
      await expect.poll(() => radio(reloadedProfileRow, "Full").isChecked()).toBe(true);
      expect(await reloadedProfileRow.textContent()).not.toContain("Using default: Full");

      expect((await page.goto(`${suite.server.baseUrl}settings/model-providers`))?.status()).toBe(
        200,
      );
      const thinkingRow = settingsRow(page, "Thinking");
      const fastModeRow = settingsRow(page, "Fast Mode");
      await radio(thinkingRow, "High").waitFor();
      expect(await radio(thinkingRow, "High").isChecked()).toBe(true);
      await expectDefaultInfo(thinkingRow, thinkingDefaultExplanation);
      await expectDefaultInfo(fastModeRow, fastModeDefaultExplanation);

      const modelSavesBefore = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await radio(thinkingRow, /^Default/u).click();
      await expectModelPatch(gateway, modelSavesBefore, true);
      await finishPatch(gateway, afterThinkingReset, "curated-defaults-model-thinking-reset", true);
      await expect.poll(() => radio(thinkingRow, /^Default/u).isEnabled()).toBe(true);
      await expect.poll(() => radio(thinkingRow, /^Default/u).isChecked()).toBe(true);
      expect(await page.getByText("Defaults saved.", { exact: true }).count()).toBe(0);
      const fastModeSavesBefore = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await radio(fastModeRow, /^Default/u).click();
      await expectModelPatch(gateway, fastModeSavesBefore, null);
      await finishPatch(gateway, afterModelResets, "curated-defaults-model-resets", true);
      await expectDefaultInfo(thinkingRow, thinkingDefaultExplanation);
      await expectDefaultInfo(fastModeRow, fastModeDefaultExplanation);
      await expect.poll(() => radio(fastModeRow, /^Default/u).isEnabled()).toBe(true);
      await expect.poll(() => radio(fastModeRow, /^Default/u).isChecked()).toBe(true);
      expect(await page.getByText("Defaults saved.", { exact: true }).count()).toBe(0);

      expect((await page.reload())?.status()).toBe(200);
      const reloadedThinkingRow = settingsRow(page, "Thinking");
      const reloadedFastModeRow = settingsRow(page, "Fast Mode");
      await expectDefaultInfo(reloadedThinkingRow, thinkingDefaultExplanation);
      await expectDefaultInfo(reloadedFastModeRow, fastModeDefaultExplanation);
      expect(await radio(reloadedThinkingRow, /^Default/u).isChecked()).toBe(true);
      expect(await radio(reloadedFastModeRow, /^Default/u).isChecked()).toBe(true);

      expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
      const reloadedCodeModeRow = settingsRow(page, "Code Mode");
      await expectQuietDefault(reloadedCodeModeRow);
      expect(
        await reloadedCodeModeRow
          .getByRole("switch", { name: "Code Mode", exact: true })
          .isChecked(),
      ).toBe(true);
    });
  });
});
