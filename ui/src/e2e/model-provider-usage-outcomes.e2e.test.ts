import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider operator outcomes mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const now = Date.now();
const unavailableMessage =
  "Provider usage is unavailable; the last request failed. Refresh to retry.";

const config = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: { providers: { openai: { apiKey: "[redacted]" } } },
};
const configuredProvider = {
  provider: "openai",
  displayName: "OpenAI",
  status: "static",
  profiles: [],
  apiKey: { source: "config" },
};
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
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
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
      // An agent switch reloads the list, so open the row again on each read.
      const credentials = async () =>
        (await expandProvider(page, "openai"))
          .locator(".model-providers__credentials")
          .textContent();
      await expect.poll(credentials).toContain("Credentials for Main");
      await openaiCard.getByRole("button", { name: "Set API key" }).click();
      await openaiCard.getByLabel("API key", { exact: true }).fill("synthetic-main-provider-key");

      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "Writer", exact: true }).click();
      await expect.poll(credentials).toContain("Credentials for Writer");
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

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
      await expect.poll(credentials).toContain("Credentials for Main");
      await expect.poll(async () => page.locator("[data-models-key-dialog]").count()).toBe(0);
      await expect.poll(async () => openaiCard.locator('input[type="password"]').count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    }, 1280);
  });
});
