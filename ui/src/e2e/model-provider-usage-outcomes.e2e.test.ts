import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { configAuth } from "./model-catalog-fixtures.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider operator outcomes mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const now = Date.now();
const unavailableMessage = "Couldn’t load provider usage. Refresh to try again.";

const config = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: { providers: { openai: { apiKey: "[redacted]" } } },
};
const configuredProvider = configAuth("openai", { displayName: "OpenAI", status: "static" });
const models = [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }];
function withPage(run: (page: Page) => Promise<void>, width = 1440) {
  return suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height: 1000, width } },
    ({ page }) => run(page),
  );
}

function providerUsageResponses(usageStatus: unknown) {
  return {
    "config.get": { config: {}, hash: "provider-usage-outcome" },
    "models.list": { models: [] },
    "models.authStatus": {
      ts: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [],
        },
      ],
    },
    "usage.status": usageStatus,
  };
}

suite.define(() => {
  it.each([1440, 390])("draws the daily cost trend at every width: %ipx", async (width) => {
    await withPage(async (page) => {
      await installMockGateway(page, {
        methodResponses: providerUsageResponses({
          updatedAt: now,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              windows: [],
              costHistory: {
                unit: "USD",
                periodDays: 2,
                daily: [2, 5].map((amount, index) => ({
                  date: new Date(now - index * 86_400_000).toISOString().slice(0, 10),
                  amount,
                  inputTokens: 100,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 100,
                  totalTokens: 200,
                })),
                models: [],
                categories: [],
              },
            },
          ],
        }),
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const row = await expandProvider(page, "openai");
      const line = row.locator(".oc-sparkline-line");
      if (width === 390) {
        await row.locator(".provider-usage__fact .provider-usage__reset").waitFor();
        expect(await line.isVisible()).toBe(true);
        return;
      }
      await line.waitFor();
      // An undefined stroke token computes to `none`: the path exists but draws nothing.
      expect(await line.evaluate((path) => getComputedStyle(path).stroke)).not.toBe("none");
    }, width);
  });

  it.each(["request failure", "provider error"] as const)(
    "distinguishes usage outcomes: %s",
    async (outcome) => {
      await withPage(async (page) => {
        const failed = outcome === "request failure";
        const gateway = await installMockGateway(page, {
          methodResponses: providerUsageResponses(
            failed
              ? {
                  __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" },
                }
              : {
                  updatedAt: now,
                  providers: [
                    {
                      provider: "openai",
                      displayName: "OpenAI",
                      windows: [],
                      error: "provider API unavailable",
                    },
                  ],
                },
          ),
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        const warning = expect.poll(() => page.locator(".settings-page").textContent());
        if (failed) {
          await warning.toContain(unavailableMessage);
          expect(await page.locator("[data-provider-id]").count()).toBe(0);
        } else {
          await page.locator('[data-provider-id="openai"]').waitFor();
          await expect
            .poll(() => page.locator('.provider-row[data-provider-id="openai"]').textContent())
            .toContain("Couldn’t check usage");
          await expandProvider(page, "openai");
          await expect
            .poll(() => page.locator('.provider-row[data-provider-id="openai"]').textContent())
            .toContain("provider API unavailable");
          await warning.not.toContain(unavailableMessage);
        }
      });
    },
  );

  it("clears unsaved provider credentials when switching agents without saving them", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
        methodResponses: {
          ...providerUsageResponses({ updatedAt: now, providers: [] }),
          "config.get": {
            config,
            sourceConfig: config,
            hash: "model-providers-configured",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "models.list": { models },
          "agents.list": createAgentRoster({ main: "Main", writer: "Writer" }, "main", "agent"),
          "config.patch": { ok: true },
          "models.authStatus": {
            ts: now,
            providerCapabilities: [
              { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
              { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
            ],
            providers: [configuredProvider],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      const scope = () => page.locator(".oc-settings-section").last().textContent();
      await expect.poll(scope).toContain("Accounts for Main");
      await expandProvider(page, "openai");
      await openaiCard.getByRole("button", { name: "Replace API key" }).click();
      await openaiCard.getByLabel("API key", { exact: true }).fill("synthetic-main-provider-key");

      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("option", { name: "Writer", exact: true }).click();
      await expect.poll(scope).toContain("Accounts for Writer");
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.locator("[data-models-connect]").click();
      await page.locator('[data-models-login-provider="google"]').click();
      const addSection = page.locator("[data-models-key-dialog]");
      await addSection.getByLabel("API key").fill("synthetic-writer-provider-key");
      // The modal makes the picker inert. Use its selection owner without
      // closing the dialog so this still proves open-draft scope retirement.
      await evaluateControlUiContext(page, (context) => {
        context.settingsAgentSelection.set("main");
      });
      await expect.poll(scope).toContain("Accounts for Main");
      await expect.poll(async () => page.locator("[data-models-key-dialog]").count()).toBe(0);
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    }, 1280);
  });
});
