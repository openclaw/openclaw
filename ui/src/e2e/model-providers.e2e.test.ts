// Control UI tests cover the Models settings page against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  defaultControlUiFeatureMethods,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  pickerValue as modelPickerValue,
  selectPickerValue as selectModelPicker,
} from "../test-helpers/select-picker-e2e.ts";
import {
  catalogModel,
  emptyUsage,
  providerPageOptions,
} from "./model-catalog-fixtures.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
let browser: Browser;
let server: ControlUiE2eServer;
describeControlUiE2e("Control UI Models mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps defaults read-only without an admin warning when config patches are unavailable", async () => {
    const context = await browser.newContext(
      providerPageOptions(877, 900, { colorScheme: "dark" }),
    );
    const page = await context.newPage();
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const gateway = await installMockGateway(page, {
      featureMethods: defaultControlUiFeatureMethods.filter((method) => method !== "config.patch"),
      models: [
        catalogModel("openai", "gpt-5.5", "GPT-5.5"),
        catalogModel("openai", "gpt-4.1", "GPT-4.1"),
      ],
      methodResponses: {
        "config.get": configSnapshot(config, "read-only-model-providers"),
        "models.authStatus": { ts: NOW, providers: [] },
        ...emptyUsage(NOW),
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const defaults = page.locator(".model-providers__defaults");
      await defaults.waitFor();
      const picker = defaults.locator("openclaw-select-picker").first();
      await picker.locator(".picker-select__trigger").click();
      const otherModel = picker.locator('[role="option"][data-value="openai/gpt-4.1"]');
      expect(await otherModel.getAttribute("aria-disabled")).toBe("true");
      await otherModel.click({ force: true });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await expect.poll(() => page.getByText(/operator\.admin access/u).count()).toBe(0);
      await page.keyboard.press("Escape");
      const actions = page.locator("[data-models-connect], .model-providers__refresh-button");
      for (const viewportWidth of [1440, 390]) {
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        const boxes = await actions.evaluateAll((buttons) =>
          buttons.map((button) => {
            const { x, y, width, height } = button.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
        expect(boxes).toHaveLength(2);
        const [connect, refresh] = boxes;
        expect(connect!.x + connect!.width).toBeLessThanOrEqual(refresh!.x);
        expect(
          Math.abs(connect!.y + connect!.height / 2 - refresh!.y - refresh!.height / 2),
        ).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      const providerTitle = page.locator('[data-provider-id="openai"] .provider-row__name').first();
      await expect
        .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().width))
        .toBeGreaterThan(40);
      await expect
        .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().height))
        .toBeLessThan(32);
    } finally {
      await context.close();
    }
  });

  it("refreshes saved models while retaining rejection feedback until access changes", async () => {
    const context = await browser.newContext(providerPageOptions(1280, 1000));
    const page = await context.newPage();
    const initialConfig = {
      agents: { defaults: { model: "openai/initial-model" } },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configSnapshot(initialConfig, "model-providers-reconnect-1"),
        "models.list": {
          models: [
            catalogModel("openai", "initial-model", "Initial Model"),
            catalogModel("openai", "failed-draft", "Failed Draft"),
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:writer", type: "oauth", status: "ok" }],
            },
          ],
        },
        ...emptyUsage(NOW),
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "Writer", exact: true }).click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/initial-model");

      const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
      await gateway.deferNext("config.patch");
      const failedPatchCount = (await gateway.getRequests("config.patch")).length;
      await selectModelPicker(primary, "openai/failed-draft");
      await gateway.waitForRequest("config.patch", { after: failedPatchCount });
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "synthetic model save rejected",
      });
      await page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }).waitFor();
      const reconnectedConfig = {
        agents: { defaults: { model: "openai/reconnected-model" } },
      };
      await gateway.setMethodResponse(
        "config.get",
        configSnapshot(reconnectedConfig, "model-providers-reconnect-2"),
      );
      await gateway.setMethodResponse("models.list", {
        models: [catalogModel("openai", "reconnected-model", "Reconnected Model")],
      });
      const authRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.closeLatest(1012, "model provider reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(authRequestCount);
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/reconnected-model");
      expect(await page.getByRole("alert").textContent()).toContain(
        "synthetic model save rejected",
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(failedPatchCount + 1);
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      for (const request of (await gateway.getRequests("models.authStatus")).slice(
        authRequestCount,
      )) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
      const accessChangeAuthCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.setOperatorScopes(["operator.read"]);
      await gateway.closeLatest(1012, "model provider access-change proof");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(accessChangeAuthCount);
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      await primary.locator(".picker-select__trigger").click();
      const readOnlyModel = primary.locator(
        '[role="option"][data-value="openai/reconnected-model"]',
      );
      expect(await readOnlyModel.getAttribute("aria-disabled")).toBe("true");
      await readOnlyModel.click({ force: true });
      expect(await gateway.getRequests("config.patch")).toHaveLength(failedPatchCount + 1);
    } finally {
      await context.close();
    }
  });
});
