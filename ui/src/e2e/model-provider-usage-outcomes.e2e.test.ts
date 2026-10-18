// Control UI E2E proves provider-usage request failures remain distinct from provider data.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  readyProvider,
  button,
  catalogModel,
  configKeyProvider,
  configSnapshot,
  createScreenshots,
  keyCapability,
  pageOptions,
  text,
} from "./model-provider-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider operator outcomes mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const now = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const unavailableMessage =
  "Provider usage is unavailable; the last request failed. Refresh to retry.";

function providerUsageResponses(usageStatus: unknown) {
  return {
    "config.get": { config: {}, hash: "provider-usage-outcome" },
    "models.list": { models: [] },
    "models.authStatus": {
      ts: now,
      providers: [readyProvider("openai", "OpenAI", [])],
    },
    "sessions.usage": { aggregates: { byProvider: [] } },
    "usage.status": usageStatus,
  };
}

const capture = createScreenshots(() => path.join(suite.artifactDir, "model-providers"), {
  animations: "disabled",
});

suite.define(() => {
  it("shows usage request failures with no configured providers", async () => {
    await suite.withPage(pageOptions(1_440, 1_000), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: providerUsageResponses({
          __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" },
        }),
      });

      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await expect
        .poll(async () => (await gateway.getRequests("usage.status")).length)
        .toBeGreaterThan(0);
      await text(page.locator(".settings-page")).toContain(unavailableMessage);
      expect(await page.locator("[data-provider-id]").count()).toBe(0);
      await capture(page, "provider-usage-request-failed.png", { fullPage: true });
    });
  });

  it("keeps provider-scoped usage errors as data without the global warning", async () => {
    await suite.withPage(pageOptions(1_440, 1_000), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: providerUsageResponses({
          updatedAt: now,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              windows: [],
              error: "provider API unavailable",
            },
          ],
        }),
      });

      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const card = page.locator('[data-provider-id="openai"]');
      await card.waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("usage.status")).length)
        .toBeGreaterThan(0);
      await text(card).toContain("provider API unavailable");
      await text(page.locator(".settings-page")).not.toContain(unavailableMessage);
      await capture(card, "provider-usage-provider-error.png");
    });
  });

  it("keeps configured models visible when their catalog fails, then recovers on refresh", async () => {
    await suite.withPage(pageOptions(1_440, 1_000), async ({ page }) => {
      const config = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        models: { providers: { openai: { apiKey: "[redacted]" } } },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...providerUsageResponses({ updatedAt: now, providers: [] }),
          "config.get": configSnapshot(config, "model-providers-catalog-failure"),
          "models.list": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "Model catalog temporarily unavailable",
            },
          },
          "models.authStatus": {
            ts: now,
            providers: [configKeyProvider("openai", "OpenAI")],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const card = page.locator('[data-provider-id="openai"]');
      await card.waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("models.list")).length)
        .toBeGreaterThan(0);
      const catalogWarning = page.locator('.model-providers__catalog-progress[role="alert"]');

      if (recordVisuals) {
        await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
        const phase = (await catalogWarning.count()) === 0 ? "before" : "after";
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(
            path.join(suite.artifactDir, "model-providers"),
            `model-catalog-request-failure-${phase}.png`,
          ),
        });
      }

      await expect
        .poll(() => catalogWarning.textContent(), { timeout: 5_000 })
        .toContain("Model catalog temporarily unavailable");
      await button(catalogWarning, "Retry").waitFor();
      expect(await page.locator(".provider-usage-error").count()).toBe(0);
      expect(await page.locator('[data-model-readiness="model-required"]').count()).toBe(0);
      const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
      await expect.poll(() => pickerValue(primary)).toBe("openai/gpt-5.5");

      await gateway.setMethodResponse("models.list", {
        models: [catalogModel("openai", "gpt-5.5", "GPT-5.5")],
      });
      await button(page, "Refresh").click();

      await expect.poll(() => catalogWarning.count()).toBe(0);
      await expect.poll(() => page.locator(".provider-usage-error").count()).toBe(0);
      await text(card).toContain("API key set in config");
      await expect.poll(() => pickerValue(primary)).toBe("openai/gpt-5.5");
      await capture(page, "model-catalog-request-recovered.png", { fullPage: true });
    });
  });

  it("clears unsaved provider credentials when switching agents without saving them", async () => {
    await suite.withPage(pageOptions(1_280, 1_000), async ({ page }) => {
      const config = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        models: { providers: { openai: { apiKey: "[redacted]" } } },
      };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
        methodResponses: {
          ...providerUsageResponses({ updatedAt: now, providers: [] }),
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": configSnapshot(config, "model-providers-agent-credentials"),
          "config.patch": { ok: true },
          "models.list": {
            models: [catalogModel("openai", "gpt-5.5", "GPT-5.5")],
          },
          "models.authStatus": {
            ts: now,
            providerCapabilities: [keyCapability("openai"), keyCapability("google")],
            providers: [configKeyProvider("openai", "OpenAI")],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      await text(openaiCard).toContain("Credentials for Main");
      await openaiCard.getByRole("button", { name: "Set API key" }).click();
      await capture(page, "provider-credential-scope-before.png", { fullPage: true });
      await openaiCard.getByLabel("API key").fill("synthetic-main-provider-key");

      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "Writer", exact: true }).click();
      await text(openaiCard).toContain("Credentials for Writer");
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await capture(page, "provider-credential-scope-inline-cleared.png", { fullPage: true });

      await page.locator("[data-models-connect]").click();
      await page.locator('[data-models-login-provider="google"]').click();
      await page.locator("[data-models-login-api-key]").click();
      const addSection = page.locator("[data-models-key-dialog]");
      await addSection.getByLabel("API key").fill("synthetic-writer-provider-key");
      // The modal makes the picker inert. Use its selection owner without
      // closing the dialog so this still proves open-draft scope retirement.
      await evaluateControlUiContext(page, (context) => {
        context.settingsAgentSelection.set("main");
      });
      await text(openaiCard).toContain("Credentials for Main");
      await expect.poll(async () => page.locator("[data-models-key-dialog]").count()).toBe(0);
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await capture(page, "provider-credential-scope-after.png", { fullPage: true });
    });
  });
});
