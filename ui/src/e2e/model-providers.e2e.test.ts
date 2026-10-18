// Control UI tests cover the Models settings page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
  authProfile,
  catalogModel,
  configSnapshot,
  keyCapability,
  pageOptions,
  recordShot,
  text,
  trimmedText,
} from "./model-provider-fixtures.test-support.ts";
import {
  requestRaw,
  resolveConfigMutation,
  providerConfig,
  createProviderProofCapture,
} from "./model-providers.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
let readinessArtifactDir: string;
const captureProviderProof = createProviderProofCapture(() => artifactDir);
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir("model-providers");
    readinessArtifactDir = path.join(artifactDir, "models-provider-readiness");
  }
});
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
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("defers live provider discovery until refresh while preserving model setup", async () => {
    const context = await browser.newContext(pageOptions(1440, 1000, { colorScheme: "dark" }));
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
        "config.get": configSnapshot(config, "credential-only-model-provider"),
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
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [authProfile("openai:chatgpt", "oauth", "ok")],
            },
          ],
        },
        "openclaw.setup.detect": {
          candidates: [],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          workspace: "/tmp/openclaw-e2e",
          setupComplete: false,
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      const openaiCard = page.locator('[data-provider-id="openai"]');
      const readiness = page.locator('[data-model-readiness="model-required"]');
      await readiness.waitFor();
      await text(readiness).toContain("Connect a verified AI model");
      await text(readiness).toContain("Model required");
      const providerReadiness = openaiCard.locator(".model-providers__head");
      const profileStatus = openaiCard.locator(".model-providers__profile-status");
      await text(providerReadiness).toContain("Credentials configured");
      await text(providerReadiness).not.toContain("Signed in");
      await trimmedText(profileStatus).toBe("Signed in");
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
      expect(await page.locator(".model-providers__defaults").count()).toBe(1);

      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(readinessArtifactDir, "after-desktop.png"),
        });
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        const providerTitle = openaiCard.locator(".settings-row__title").first();
        await expect
          .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().width))
          .toBeGreaterThan(40);
        await expect
          .poll(() => providerTitle.evaluate((node) => node.getBoundingClientRect().height))
          .toBeLessThan(32);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(readinessArtifactDir, "after-mobile.png"),
        });
        await page.setViewportSize({ height: 1000, width: 1440 });
      }

      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await text(providerReadiness).toContain("Credentials rejected");
      await trimmedText(profileStatus).toBe("Credentials configured");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(2);

      await readiness.getByRole("button", { name: "Connect provider", exact: true }).click();
      await page.locator("[data-models-login-search]").waitFor();
      expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
    } finally {
      await context.close();
    }
  });

  it("keeps defaults read-only without an admin warning when config patches are unavailable", async () => {
    const context = await browser.newContext(pageOptions(877, 900, { colorScheme: "dark" }));
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
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
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
      await recordShot(page, {
        animations: "disabled",
        fullPage: true,
        path: path.join(artifactDir, "read-only-without-admin-warning.png"),
      });
    } finally {
      await context.close();
    }
  });

  it("lists configured providers with auth state, quota, billing, and local spend", async () => {
    const context = await browser.newContext(
      pageOptions(
        1280,
        1200,
        recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1280 } } }
          : {},
      ),
    );
    const page = await context.newPage();
    await installMockGateway(page, {
      models: [
        catalogModel("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
        catalogModel("openai", "gpt-5.5", "GPT-5.5"),
        catalogModel("google", "gemini-3-pro", "Gemini 3 Pro", false),
        catalogModel("ß-provider", "test-model", "Test Model"),
      ],
      methodResponses: {
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: [
            keyCapability("openai"),
            keyCapability("anthropic"),
            keyCapability("google"),
          ],
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [authProfile("anthropic:default", "oauth", "expired")],
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
              profiles: [authProfile("openrouter:default", "api_key", "static")],
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
        "sessions.usage": {
          updatedAt: NOW,
          sessions: [],
          totals: null,
          aggregates: {
            messages: {
              total: 0,
              user: 0,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [
              {
                provider: "anthropic",
                count: 3,
                totals: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 1_500_000,
                  totalCost: 4.2,
                  inputCost: 4.2,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                },
              },
            ],
            byAgent: [],
            byChannel: [],
            daily: [],
          },
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
      await text(claudeCard.locator(".settings-row__desc").first()).toContain("anthropic");
      await text(claudeCard).toContain("Max 20x");
      await text(claudeCard).toContain("Credentials configured");
      const claudeReadiness = claudeCard.locator(".model-providers__head");
      await text(claudeReadiness).not.toContain("Expired");
      await text(claudeReadiness).not.toContain("Expiring");
      await text(claudeReadiness).not.toContain("Not signed in");
      await text(claudeCard.locator(".model-providers__profile")).toContain("Expired");
      await text(claudeCard).toContain("$4.20");
      await claudeCard.locator(".provider-usage-progress").first().waitFor();
      await expect.poll(() => page.getByText("Model auth expired: Claude").count()).toBe(0);

      if (recordVisuals) {
        await captureProviderProof("claude-cli-oauth-alias.png", claudeCard);
      }

      const openrouterCard = page.locator(".model-providers__row", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await openrouterCard.getByRole("button", { name: "Set API key", exact: true }).waitFor();
      expect(await openrouterCard.locator(".model-providers__profile").textContent()).toContain(
        "openrouter:default",
      );
      await text(openrouterCard).toContain("$12.34");

      // openai qualifies via its available catalog model despite having no
      // auth row; the shared label map renders "OpenAI", not "Openai".
      const openaiCard = page.locator(".model-providers__row", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await text(openaiCard).toContain("1 model");

      // google is in the configured catalog with an unavailable model; the
      // page surfaces it instead of hiding the broken provider.
      const googleCard = page.locator(".model-providers__row", { hasText: "Google" });
      await googleCard.waitFor();
      await text(googleCard).toContain("0 of 1 models available");
      const fallback = page.locator(
        '[data-provider-id="ß-provider"] .provider-brand-icon--fallback',
      );
      await trimmedText(fallback).toBe("S");
      await expect.poll(async () => page.locator(".model-providers__row").count()).toBe(5);
      expect(
        await page
          .locator(".model-providers__provider-list")
          .evaluate((node) => getComputedStyle(node).rowGap),
      ).toBe("18px");
      const providerSection = page
        .locator(".settings-section")
        .filter({ has: page.locator(".model-providers__updated") });
      const headerMetrics = await providerSection.evaluate((section) => {
        const heading = section.querySelector<HTMLElement>(".settings-section__heading");
        const actions = section.querySelector<HTMLElement>(".settings-section__actions");
        const updated = section.querySelector<HTMLElement>(".model-providers__updated");
        const refresh = section.querySelector<HTMLButtonElement>(
          ".model-providers__refresh-button",
        );
        const icon = refresh?.querySelector<SVGElement>("svg");
        if (!heading || !actions || !updated || !refresh || !icon) {
          throw new Error("expected configured-provider header controls");
        }
        const updatedBounds = updated.getBoundingClientRect();
        const refreshBounds = refresh.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        return {
          centerOffset: Math.abs(
            updatedBounds.top +
              updatedBounds.height / 2 -
              (refreshBounds.top + refreshBounds.height / 2),
          ),
          iconWidth: iconBounds.width,
          textSize: Number.parseFloat(getComputedStyle(updated).fontSize),
          refreshHeight: refresh.getBoundingClientRect().height,
        };
      });
      expect(headerMetrics.centerOffset).toBeLessThanOrEqual(1);
      expect(headerMetrics.iconWidth).toBeCloseTo(headerMetrics.textSize, 1);
      expect(headerMetrics.refreshHeight).toBe(28);

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileMetrics = await providerSection.evaluate((section) => {
        const header = section.querySelector<HTMLElement>(".settings-section__header");
        const actions = section.querySelector<HTMLElement>(".settings-section__actions");
        if (!header || !actions) {
          throw new Error("expected configured-provider mobile header controls");
        }
        return {
          actionsAlignSelf: getComputedStyle(actions).alignSelf,
          flexDirection: getComputedStyle(header).flexDirection,
          overflowsViewport: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(mobileMetrics).toEqual({
        actionsAlignSelf: "flex-end",
        flexDirection: "column",
        overflowsViewport: false,
      });
    } finally {
      await context.close();
    }
  });

  it("configures credentials, probes a provider, and changes default models", async () => {
    const context = await browser.newContext(
      pageOptions(
        1280,
        1200,
        recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1280 } } }
          : {},
      ),
    );
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
        "config.get": configSnapshot(config, "model-providers-hash"),
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
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    provider: "openai",
                    available: true,
                    apiKeySupported: true,
                  },
                  {
                    id: "claude-sonnet-4-5",
                    name: "Claude Sonnet 4.5",
                    provider: "anthropic",
                    available: true,
                    apiKeySupported: true,
                  },
                  {
                    id: "gemini-3-pro",
                    name: "Gemini 3 Pro",
                    provider: "google",
                    available: true,
                    apiKeySupported: true,
                  },
                ],
              },
            },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: [
            keyCapability("openai"),
            keyCapability("anthropic"),
            keyCapability("google"),
          ],
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "static",
              profiles: [],
              apiKey: { source: "config" },
            },
            {
              provider: "anthropic",
              displayName: "Anthropic",
              status: "ok",
              profiles: [authProfile("anthropic:default", "oauth", "ok")],
            },
          ],
        },
        "models.probe": {
          provider: "openai",
          status: "ok",
          latencyMs: 9_087,
          results: [{ label: "Config API key", status: "ok", latencyMs: 87 }],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
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
      await text(openaiCard).toContain("API key set in config");
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/gpt-5.5");
      if (recordVisuals) {
        await captureProviderProof("01-configured.png", openaiCard);
      }

      await openaiCard.getByRole("button", { name: "Set API key" }).click();
      await openaiCard.getByLabel("API key").fill(openaiInputValue);
      const keyWriteCount = (await gateway.getRequests("models.authSetApiKey")).length;
      await gateway.deferNext("models.authSetApiKey");
      await openaiCard.getByRole("button", { name: "Save" }).click();
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
      await text(openaiCard).toContain("Secret saved.");

      await openaiCard.getByRole("button", { name: "Test connection" }).click();
      const probe = await gateway.waitForRequest("models.probe");
      expect(probe.params).toEqual({ provider: "openai", agentId: "main" });
      await text(openaiCard.locator(".model-providers__probe-target span").nth(1)).toBe(
        "Connected · Request round-trip: 87 ms",
      );
      expect(await openaiCard.locator(".model-providers__probe-summary").textContent()).toBe(
        "Connected",
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

      await page.locator("[data-models-connect]").click();
      await page.locator('[data-models-login-provider="google"]').click();
      await page.locator("[data-models-login-api-key]").click();
      const addSection = page.locator("[data-models-key-dialog]");
      await addSection.getByLabel("API key").fill(googleInputValue);
      const savedConfig = {
        ...updatedDefaultsConfig,
        auth: { profiles: { "google:manual-api-key": { provider: "google", mode: "api_key" } } },
      };
      await gateway.setMethodResponse("models.authStatus", {
        ts: NOW,
        providerCapabilities: [
          keyCapability("openai"),
          keyCapability("anthropic"),
          keyCapability("google"),
        ],
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            status: "static",
            profiles: [],
            apiKey: { source: "config" },
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status: "ok",
            profiles: [authProfile("anthropic:default", "oauth", "ok")],
          },
          {
            provider: "google",
            displayName: "Google",
            status: "static",
            profiles: [
              authProfile("google:manual-api-key", "api_key", "static", { logoutSupported: true }),
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

      if (recordVisuals) {
        await captureProviderProof("02-probed.png", page.locator('[data-provider-id="google"]'));
      }
      await page.reload();
      await expect.poll(() => modelPickerValue(primary)).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await context.close();
    }
  });

  it("autosaves utility choices without a primary model and retains them after reload", async () => {
    const context = await browser.newContext(
      pageOptions(
        1280,
        1000,
        recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
          : {},
      ),
    );
    const page = await context.newPage();
    let config: unknown = { agents: { defaults: {} } };
    let hash = "utility-defaults";
    const snapshot = () => configSnapshot(config, hash);
    const gateway = await installMockGateway(page, {
      models: [catalogModel("openai", "gpt-5-mini", "GPT-5 Mini")],
      methodResponses: {
        "config.get": snapshot(),
        "models.authStatus": { ts: NOW, providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });
    const observations: unknown[] = [];
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const defaults = page.locator(".model-providers__defaults");
      const utility = page.locator("openclaw-select-picker:has(#model-providers-utility-model)");
      await expect.poll(() => modelPickerValue(utility)).toBe("__openclaw_automatic_utility__");
      if (recordVisuals) {
        await captureProviderProof("utility-before.png", utility);
      }
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
        observations.push({ choice, request, config, selected: await modelPickerValue(utility) });
        if (recordVisuals) {
          await captureProviderProof(`utility-${choice.label}-saved.png`, utility);
        }
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
        await expect.poll(() => modelPickerValue(utility)).toBe(choice.value);
        await expect
          .poll(() => modelPickerValue(defaults.locator("openclaw-select-picker").first()))
          .toBe("");
        if (recordVisuals) {
          await captureProviderProof(`utility-${choice.label}-reloaded.png`, utility);
        }
      }
    } finally {
      try {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "utility-observations.json"),
            JSON.stringify(observations, null, 2),
          );
          await captureProviderProof(
            "utility-final.png",
            page.locator("openclaw-select-picker:has(#model-providers-utility-model)"),
          );
        }
      } finally {
        await context.close();
      }
    }
  });

  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    const context = await browser.newContext(
      pageOptions(
        1280,
        1000,
        recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
          : {},
      ),
    );
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
              profiles: [authProfile("openai:writer", "oauth", "ok")],
            },
          ],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.getByRole("menuitemradio", { name: "Writer", exact: true }).click();
      await trimmedText(agentPicker.locator(".agent-select__label")).toBe("Writer");
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
      if (recordVisuals) {
        await captureProviderProof(
          "05-reconnect-save-error.png",
          page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }),
        );
      }

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
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      await trimmedText(agentPicker.locator(".agent-select__label")).toBe("Writer");
      for (const request of (await gateway.getRequests("models.authStatus")).slice(
        authRequestCount,
      )) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
      if (recordVisuals) {
        await captureProviderProof("06-reconnected-model.png", primary);
      }
    } finally {
      await context.close();
    }
  });
});
