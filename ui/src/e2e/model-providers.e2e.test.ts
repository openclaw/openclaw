// Control UI tests cover the Models settings page against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
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
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import {
  catalogModel,
  emptyUsage,
  keyCapabilities,
  providerPageOptions,
  configAuth,
} from "./model-catalog-fixtures.test-support.ts";
import {
  requestRaw,
  resolveConfigMutation,
  providerConfig,
  expandProvider,
} from "./model-providers.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const redactedConfigValue = "[redacted]";
const openaiInputValue = ["e2e", "test", "key"].join("-");
const googleInputValue = ["e2e", "google", "key"].join("-");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Models mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    const { wsEndpoint } = inject("controlUiE2eChromium");
    if (!wsEndpoint) {
      throw new Error("Control UI E2E requires its shared Chromium server");
    }
    browser = await chromium.connect(wsEndpoint);
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("defers live provider discovery until refresh while preserving model setup", async () => {
    const context = await browser.newContext(
      providerPageOptions(1440, 1000, { colorScheme: "dark" }),
    );
    const page = await context.newPage();
    const config = { auth: { profiles: { "openai:chatgpt": { provider: "openai" } } } };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.patch",
        "models.probe",
        "openclaw.setup.detect",
      ],
      methodResponses: {
        "config.get": sourceConfigSnapshot(config, "credential-only-model-provider"),
        "models.list": {
          cases: [
            {
              match: { view: "configured", agentId: "main", refresh: true },
              response: {
                models: [],
                refreshFailed: true,
                providerOutcomes: [{ provider: "openai", status: "auth-rejected" }],
              },
            },
            {
              match: { view: "configured", agentId: "main" },
              response: { models: [] },
            },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: keyCapabilities("openai"),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
            },
          ],
        },
        "openclaw.setup.detect": {
          candidates: [],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        ...emptyUsage(NOW),
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      await openaiCard.waitFor();
      const providerReadiness = openaiCard.locator(".model-providers__head");
      const profileStatus = openaiCard.locator(".model-providers__profile-status");
      await expect.poll(async () => providerReadiness.textContent()).not.toContain("Signed in");
      await expandProvider(page, "openai");
      await expect.poll(async () => (await profileStatus.textContent())?.trim()).toBe("");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({
          params: { agentId: "main", view: "configured" },
        }),
      ]);
      expect(await page.getByRole("heading", { name: "Add provider" }).count()).toBe(0);
      // A signed-in provider can list models, so the defaults (and any listing error) show.
      expect(await page.locator(".model-providers__defaults").count()).toBe(1);

      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect
        .poll(async () => providerReadiness.textContent())
        .toContain("Credentials rejected");
      await expect.poll(async () => (await profileStatus.textContent())?.trim()).toBe("");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(2);

      await page.locator('[data-models-catalog-provider="openai"] button').click();
      await page.locator(".model-provider-login").waitFor();
      expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
    } finally {
      await context.close();
    }
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
        "config.get": sourceConfigSnapshot(config, "read-only-model-providers"),
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
    } finally {
      await context.close();
    }
  });

  it("lists configured providers with auth state, quota, and billing", async () => {
    const context = await browser.newContext(providerPageOptions(1280, 1200));
    const page = await context.newPage();
    await installMockGateway(page, {
      models: [
        catalogModel("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
        catalogModel("openai", "gpt-5.5", "GPT-5.5"),
        catalogModel("google", "gemini-3-pro", "Gemini 3 Pro", false),
        catalogModel("ß-provider", "test-model", "Test Model"),
      ],
      methodResponses: {
        // The agent's chosen model keeps setup out of the way of provider access.
        "config.get": sourceConfigSnapshot(
          { agents: { defaults: { model: "openai/gpt-5.5" } } },
          "configured-providers",
        ),
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: keyCapabilities("openai", "anthropic", "google"),
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [
                {
                  profileId: "anthropic:default",
                  type: "oauth",
                  status: "expired",
                  expiry: { at: NOW - 1, remainingMs: -1, label: "0m" },
                },
              ],
              usage: {
                providerId: "anthropic",
                plan: "Max 20x",
                windows: [{ label: "5h", usedPercent: 38, resetAt: NOW + 2 * 3_600_000 }],
              },
            },
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              status: "static",
              profiles: [{ profileId: "openrouter:default", type: "api_key", status: "static" }],
            },
          ],
        },
        "usage.status": {
          updatedAt: NOW,
          providers: [
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              windows: [],
              billing: [{ type: "balance", amount: 12.34, unit: "USD" }],
            },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      const claudeCard = page.locator(".model-providers__row", { hasText: "Claude" });
      await claudeCard.waitFor();
      // Alias auth row (claude-cli) merges onto the canonical anthropic card.
      await expect.poll(async () => claudeCard.getAttribute("data-provider-id")).toBe("anthropic");
      await expect.poll(async () => claudeCard.textContent()).toContain("Max 20x");
      const claudeReadiness = claudeCard.locator(".model-providers__head");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Expired");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Expiring");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Not signed in");
      await expandProvider(page, "anthropic");
      const claudeProfile = claudeCard.locator(".model-providers__profile");
      await expect.poll(async () => claudeProfile.textContent()).toContain("Access token expired");
      expect(await claudeProfile.textContent()).toContain(
        "Access-token expiry alone does not mean you need to sign in again.",
      );
      const fiveHour = claudeCard.locator(".provider-usage__window", { hasText: "5h" });
      await expect.poll(() => fiveHour.textContent()).toContain("62% left");
      await expect.poll(() => fiveHour.textContent()).toContain("Resets");
      await expect.poll(() => page.getByText("Model auth expired: Claude").count()).toBe(0);

      const openrouterCard = page.locator(".model-providers__row", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await expandProvider(page, "openrouter");
      await openrouterCard
        .getByRole("button", { name: "Replace API key: OpenRouter", exact: true })
        .waitFor();
      expect(
        await openrouterCard.locator(".model-providers__profile-copy strong").getAttribute("title"),
      ).toBe("openrouter:default");
      await expect
        .poll(async () =>
          page.locator('.provider-row[data-provider-id="openrouter"]').textContent(),
        )
        .toContain("$12.34");

      // openai qualifies via its available catalog model despite having no
      // auth row; the shared label map renders "OpenAI", not "Openai".
      const openaiCard = page.locator(".model-providers__row", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");

      // google is in the configured catalog with an unavailable model; the
      // page surfaces it instead of hiding the broken provider.
      const googleCard = page.locator(".model-providers__row", { hasText: "Google" });
      await googleCard.waitFor();
      await expect.poll(async () => googleCard.textContent()).toContain("1 model in the catalog");
      // Without credentials or a usable model it sits in the quiet group.
      expect(
        await page
          .locator(".provider-list--quiet .provider-row")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-provider-id"))),
      ).toEqual(["google"]);
      const fallback = page.locator(
        '[data-provider-id="ß-provider"] .provider-brand-icon--fallback',
      );
      await expect.poll(async () => (await fallback.textContent())?.trim()).toBe("S");
      await expect.poll(async () => page.locator(".model-providers__row").count()).toBe(5);
    } finally {
      await context.close();
    }
  });

  it("preserves ready setup after a no-model access probe", async () => {
    const context = await browser.newContext(providerPageOptions(1280, 1000));
    const page = await context.newPage();
    const config = { models: { providers: { openai: providerConfig(redactedConfigValue) } } };
    const models = [catalogModel("openai", "example-model", "Example model")];
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "models.probe"],
      models,
      methodResponses: {
        "config.get": sourceConfigSnapshot(config, "no-model-probe"),
        "models.list": { models, providerOutcomes: [{ provider: "openai", status: "ready" }] },
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: keyCapabilities("openai"),
          providers: [configAuth("openai", { displayName: "OpenAI", status: "static" })],
        },
        "models.probe": { provider: "openai", status: "no_model", results: [] },
        ...emptyUsage(NOW),
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const row = await expandProvider(page, "openai");
      await row.getByRole("button", { name: "Test access: OpenAI", exact: true }).click();
      await gateway.waitForRequest("models.probe");
      await expect
        .poll(() => row.locator(".model-providers__probe-summary").textContent())
        .toBe("No models available");
      expect(await row.locator(".provider-row__status").textContent()).toBe("Ready");
    } finally {
      await context.close();
    }
  });

  it("configures credentials, probes a provider, and changes default models", async () => {
    const context = await browser.newContext(providerPageOptions(1280, 1200));
    const page = await context.newPage();
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          utilityModel: "openai/gpt-5.5-mini",
        },
      },
      models: { providers: { openai: providerConfig(redactedConfigValue) } },
    };
    const configuredModels = [
      catalogModel("openai", "gpt-5.5", "GPT-5.5"),
      catalogModel("openai", "gpt-5.5-mini", "GPT-5.5 Mini"),
      catalogModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "models.probe",
        "models.authSetApiKey",
      ],
      models: [...configuredModels, catalogModel("google", "gemini-3-pro", "Gemini 3 Pro")],
      methodResponses: {
        "config.get": sourceConfigSnapshot(config, "model-providers-hash"),
        "models.list": {
          cases: [
            {
              match: { view: "configured" },
              response: { models: configuredModels },
            },
            {
              match: { view: "all", agentId: "main", refresh: true },
              response: {
                models: [
                  { ...catalogModel("openai", "gpt-5.5", "GPT-5.5"), apiKeySupported: true },
                  {
                    ...catalogModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
                    apiKeySupported: true,
                  },
                  {
                    ...catalogModel("google", "gemini-3-pro", "Gemini 3 Pro"),
                    apiKeySupported: true,
                  },
                ],
              },
            },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: keyCapabilities("openai", "anthropic", "google"),
          providers: [
            configAuth("openai", { displayName: "OpenAI", status: "static" }),
            {
              provider: "anthropic",
              displayName: "Anthropic",
              status: "ok",
              profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
            },
          ],
        },
        "models.probe": {
          provider: "openai",
          status: "ok",
          latencyMs: 9_087,
          results: [{ label: "Config API key", status: "ok", latencyMs: 87 }],
        },
        ...emptyUsage(NOW),
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      await openaiCard.waitFor();
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toEqual([
        expect.objectContaining({
          params: { agentId: "main", view: "configured" },
        }),
      ]);
      await expect.poll(async () => openaiCard.textContent()).toContain("API key set in config");
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/gpt-5.5");

      await expandProvider(page, "openai");
      for (const action of [
        "Remove provider",
        "Remove saved access",
        "Add account",
        "Test access",
      ]) {
        const control = openaiCard.getByRole("button", { name: `${action}: OpenAI`, exact: true });
        expect(await control.count()).toBe(1);
        expect((await control.textContent())?.trim()).toBe(action);
      }
      const anthropicCard = await expandProvider(page, "anthropic");
      await anthropicCard
        .getByRole("button", { name: "Set API key: Anthropic", exact: true })
        .waitFor();
      const setKey = openaiCard.getByRole("button", {
        name: "Replace API key: OpenAI",
        exact: true,
      });
      await setKey.focus();
      await page.keyboard.press("Enter");
      await openaiCard.getByLabel("API key", { exact: true }).fill(openaiInputValue);
      const keyWriteCount = (await gateway.getRequests("models.authSetApiKey")).length;
      await gateway.deferNext("models.authSetApiKey");
      await openaiCard.getByRole("button", { name: "Save", exact: true }).click();
      const keyWrite = await gateway.waitForRequest("models.authSetApiKey", {
        after: keyWriteCount,
      });
      expect(keyWrite.params).toEqual({
        provider: "openai",
        agentId: "main",
        apiKey: openaiInputValue,
      });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      const keyedConfig = {
        ...config,
        models: { providers: { openai: providerConfig("openai:manual-api-key") } },
      };
      await resolveConfigMutation(gateway, keyedConfig, "model-providers-hash-key", "openai");
      // The saved key is checked right away with the same probe as Test access.
      await expect
        .poll(async () => openaiCard.textContent())
        .toContain("API key saved and verified.");
      const probeCount = (await gateway.getRequests("models.probe")).length;
      expect(probeCount).toBe(1);

      await gateway.deferNext("models.probe");
      const testConnection = openaiCard.getByRole("button", {
        name: "Test access: OpenAI",
        exact: true,
      });
      await testConnection.focus();
      await page.keyboard.press("Enter");
      const probe = await gateway.waitForRequest("models.probe", { after: probeCount });
      expect(probe.params).toEqual({ provider: "openai", agentId: "main" });
      const testing = openaiCard.getByRole("button", { name: "Testing…: OpenAI", exact: true });
      await expect.poll(() => testing.isDisabled()).toBe(true);
      await gateway.resolveDeferred("models.probe");
      await expect.poll(() => testConnection.isEnabled()).toBe(true);
      await expect
        .poll(() => openaiCard.locator(".model-providers__probe-target span").nth(1).textContent())
        .toBe("Access verified · Request round-trip: 87 ms");
      expect(await openaiCard.locator(".model-providers__probe-summary").textContent()).toBe(
        "Access verified",
      );

      const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
      const defaultPatchCount = (await gateway.getRequests("config.patch")).length;
      const updatedDefaultsConfig = {
        ...keyedConfig,
        agents: {
          defaults: {
            ...config.agents.defaults,
            model: "anthropic/claude-sonnet-4-5",
          },
        },
      };
      await gateway.deferNext("config.patch");
      await selectModelPicker(primary, "anthropic/claude-sonnet-4-5");
      expect(
        requestRaw(await gateway.waitForRequest("config.patch", { after: defaultPatchCount })),
      ).toEqual({
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-5",
            utilityModel: "openai/gpt-5.5-mini",
            thinkingDefault: null,
            fastModeDefault: null,
          },
        },
      });
      await resolveConfigMutation(gateway, updatedDefaultsConfig, "model-providers-hash-defaults");
      await expect.poll(() => primary.locator("button").first().isEnabled()).toBe(true);
      expect(await modelPickerValue(primary)).toBe("anthropic/claude-sonnet-4-5");
      expect(await page.locator(".model-providers__defaults .callout.success").count()).toBe(0);

      await page.locator('[data-models-catalog-provider="google"] button').click();
      const addSection = page.locator("[data-models-key-dialog]");
      await addSection.getByLabel("API key").fill(googleInputValue);
      const savedConfig = {
        ...updatedDefaultsConfig,
        auth: { profiles: { "google:manual-api-key": { provider: "google", mode: "api_key" } } },
      };
      await gateway.setMethodResponse("models.authStatus", {
        ts: NOW,
        providerCapabilities: keyCapabilities("openai", "anthropic", "google"),
        providers: [
          configAuth("openai", { displayName: "OpenAI", status: "static" }),
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status: "ok",
            profiles: [{ profileId: "anthropic:default", type: "oauth", status: "ok" }],
          },
          {
            provider: "google",
            displayName: "Google",
            status: "static",
            profiles: [
              {
                profileId: "google:manual-api-key",
                type: "api_key",
                status: "static",
                logoutSupported: true,
              },
            ],
          },
        ],
      });
      const addCount = (await gateway.getRequests("models.authSetApiKey")).length;
      const configWriteCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("models.authSetApiKey");
      await addSection.getByRole("button", { name: "Save provider" }).click();
      expect(
        (await gateway.waitForRequest("models.authSetApiKey", { after: addCount })).params,
      ).toEqual({ provider: "google", agentId: "main", apiKey: googleInputValue });
      await resolveConfigMutation(gateway, savedConfig, "model-providers-hash-2", "google");
      expect(await gateway.getRequests("config.patch")).toHaveLength(configWriteCount);
      await page.locator('[data-provider-id="google"]').waitFor();

      await page.reload();
      await expect.poll(() => modelPickerValue(primary)).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await context.close();
    }
  });

  it("autosaves utility choices without a primary model and retains them after reload", async () => {
    const context = await browser.newContext(providerPageOptions(1280, 1000));
    const page = await context.newPage();
    let config: unknown = { agents: { defaults: {} } };
    let hash = "utility-defaults";
    const snapshot = () => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
      issues: [],
    });
    const gateway = await installMockGateway(page, {
      models: [catalogModel("openai", "gpt-5-mini", "GPT-5 Mini")],
      methodResponses: {
        "config.get": snapshot(),
        "models.authStatus": { ts: NOW, providers: [] },
        ...emptyUsage(NOW),
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const defaults = page.locator(".model-providers__defaults");
      await defaults.locator("[data-models-more-settings]").click();
      const utility = page.locator("openclaw-select-picker:has(#model-providers-utility-model)");
      await expect.poll(() => modelPickerValue(utility)).toBe("__openclaw_automatic_utility__");
      for (const choice of [
        { label: "GPT-5 Mini", value: "openai/gpt-5-mini", setting: "openai/gpt-5-mini" },
        { label: "Disabled", value: "", setting: "" },
        { label: "Auto", value: "__openclaw_automatic_utility__", setting: null },
      ]) {
        const before = (await gateway.getRequests("config.patch")).length;
        await gateway.deferNext("config.patch");
        await selectModelPicker(utility, choice.value);
        const request = await gateway.waitForRequest("config.patch", { after: before });
        const patch = requestRaw(request);
        // The fixture commits the actual wire patch, not the expected selection.
        const next = applyMergePatch(config, patch);
        const noop = JSON.stringify(next) === JSON.stringify(config);
        hash = noop ? hash : `${hash}-updated`;
        config = next;
        await gateway.setMethodResponse("config.get", snapshot());
        await gateway.resolveDeferred("config.patch", { ok: true, config, hash, noop });
        await expect.poll(() => utility.locator("button").first().isEnabled()).toBe(true);
        expect(await modelPickerValue(utility)).toBe(choice.value);
        expect(await defaults.locator(".callout.success").count()).toBe(0);
        expect(patch).toEqual({
          agents: {
            defaults: {
              utilityModel: choice.setting,
              thinkingDefault: null,
              fastModeDefault: null,
            },
          },
        });
        await expect.poll(() => modelPickerValue(utility)).toBe(choice.value);
        await page.reload();
        const moreSettings = defaults.locator("[data-models-more-settings]");
        await moreSettings.waitFor();
        if ((await moreSettings.getAttribute("aria-expanded")) !== "true") {
          await moreSettings.click();
        }
        await expect.poll(() => modelPickerValue(utility)).toBe(choice.value);
        await expect
          .poll(() => modelPickerValue(defaults.locator("openclaw-select-picker").first()))
          .toBe("");
      }
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
        "agents.list": createAgentRoster({ main: "Main", writer: "Writer" }, "main", "agent"),
        "config.get": sourceConfigSnapshot(initialConfig, "model-providers-reconnect-1"),
        "models.list": {
          models: [
            catalogModel("openai", "initial-model", "Initial Model"),
            catalogModel("openai", "saved-model", "Saved Model"),
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
      await agentPicker.getByRole("option", { name: "Writer", exact: true }).click();
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
      const savedConfig = {
        agents: { defaults: { model: "openai/saved-model" } },
      };
      const savedPatchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await selectModelPicker(primary, "openai/saved-model");
      await gateway.waitForRequest("config.patch", { after: savedPatchCount });
      await resolveConfigMutation(gateway, savedConfig, "model-providers-reconnect-saved");
      await expect.poll(() => primary.locator("button").first().isEnabled()).toBe(true);
      expect(await modelPickerValue(primary)).toBe("openai/saved-model");
      expect(await page.locator(".model-providers__defaults .callout.success").count()).toBe(0);

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
        sourceConfigSnapshot(reconnectedConfig, "model-providers-reconnect-2"),
      );
      await gateway.setMethodResponse("models.list", {
        models: [catalogModel("openai", "reconnected-model", "Reconnected Model")],
      });
      // The rail retains its main-agent scope while Settings follows Writer.
      const authScope = { agentId: "writer" };
      const authRequestCount = (await gateway.getRequests("models.authStatus", authScope)).length;
      await gateway.closeLatest(1012, "model provider reconnect proof");
      await gateway.waitForRequest("models.authStatus", {
        after: authRequestCount,
        match: authScope,
      });
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

      const accessAuthCount = (await gateway.getRequests("models.authStatus", authScope)).length;
      await gateway.setOperatorScopes(["operator.read"]);
      await gateway.closeLatest(1012, "model provider access-change proof");
      await gateway.waitForRequest("models.authStatus", {
        after: accessAuthCount,
        match: authScope,
      });
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
