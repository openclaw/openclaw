// Control UI tests cover the Models settings page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  pickerValue as modelPickerValue,
  selectPickerValue as selectModelPicker,
} from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  readyProvider,
  videoPageOptions,
  authProfile,
  button,
  catalogModel,
  configKeyProvider,
  configSnapshot,
  createRecordedProviderProof,
  emptyUsage,
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
} from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Models mocked Gateway E2E" });
const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
let readinessArtifactDir: string;
const captureProviderProof = createRecordedProviderProof(() => artifactDir);
const redactedConfigValue = "[redacted]";
const openaiInputValue = ["e2e", "test", "key"].join("-");
const googleInputValue = ["e2e", "google", "key"].join("-");

suite.define(() => {
  beforeEach(() => {
    if (recordVisuals) {
      artifactDir = suite.artifactDir;
      readinessArtifactDir = path.join(artifactDir, "models-provider-readiness");
    }
  });
  it("defers live provider discovery until refresh while preserving model setup", async () => {
    await suite.withPage(pageOptions(1440, 1000, { colorScheme: "dark" }), async ({ page }) => {
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
              readyProvider("openai", "OpenAI", [authProfile("openai:chatgpt", "oauth", "ok")]),
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
      const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
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
      await button(page, "Refresh").click();
      await text(providerReadiness).toContain("Credentials rejected");
      await trimmedText(profileStatus).toBe("Credentials configured");
      expect(
        (await gateway.getRequests("models.list")).filter(
          (request) => (request.params as { view?: string } | undefined)?.view === "all",
        ),
      ).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(2);
      await button(readiness, "Connect provider").click();
      await page.locator("[data-models-login-search]").waitFor();
      expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
    });
  });

  it("keeps defaults read-only without an admin warning when config patches are unavailable", async () => {
    await suite.withPage(pageOptions(877, 900, { colorScheme: "dark" }), async ({ page }) => {
      const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
      const gateway = await installMockGateway(page, {
        featureMethods: defaultControlUiFeatureMethods.filter(
          (method) => method !== "config.patch",
        ),
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
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
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
    });
  });

  it("lists configured providers with auth state, quota, billing, and local spend", async () => {
    await suite.withPage(videoPageOptions(1280, 1200, artifactDir), async ({ page }) => {
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
            providerCapabilities: ["openai", "anthropic", "google"].map(keyCapability),
            providers: [
              readyProvider(
                "claude-cli",
                "Claude",
                [authProfile("anthropic:default", "oauth", "expired")],
                {
                  usage: {
                    providerId: "anthropic",
                    plan: "Max 20x",
                    windows: [{ label: "5h", usedPercent: 38, resetAt: NOW + 2 * 3_600_000 }],
                  },
                },
              ),
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
            aggregates: {
              byProvider: [
                {
                  provider: "anthropic",
                  count: 3,
                  totals: {
                    totalTokens: 1_500_000,
                    totalCost: 4.2,
                  },
                },
              ],
            },
          },
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();
      const claudeCard = page.locator(".model-providers__row", { hasText: "Claude" });
      await claudeCard.waitFor();
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
      await captureProviderProof("claude-cli-oauth-alias.png", claudeCard);
      const openrouterCard = page.locator(".model-providers__row", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await button(openrouterCard, "Set API key").waitFor();
      expect(await openrouterCard.locator(".model-providers__profile").textContent()).toContain(
        "openrouter:default",
      );
      await text(openrouterCard).toContain("$12.34");
      const openaiCard = page.locator(".model-providers__row", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await text(openaiCard).toContain("1 model");
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
    });
  });

  it("configures credentials, probes a provider, and changes default models", async () => {
    await suite.withPage(videoPageOptions(1280, 1200, artifactDir), async ({ page }) => {
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
                    configuredModels[0],
                    configuredModels[2],
                    catalogModel("google", "gemini-3-pro", "Gemini 3 Pro"),
                  ].map((model) => Object.assign({}, model, { apiKeySupported: true })),
                },
              },
            ],
          },
          "models.authStatus": {
            ts: NOW,
            providerCapabilities: ["openai", "anthropic", "google"].map(keyCapability),
            providers: [
              configKeyProvider("openai", "OpenAI"),
              readyProvider("anthropic", "Anthropic", [
                authProfile("anthropic:default", "oauth", "ok"),
              ]),
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
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
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
      await captureProviderProof("01-configured.png", openaiCard);
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
        providerCapabilities: ["openai", "anthropic", "google"].map(keyCapability),
        providers: [
          configKeyProvider("openai", "OpenAI"),
          readyProvider("anthropic", "Anthropic", [
            authProfile("anthropic:default", "oauth", "ok"),
          ]),
          {
            provider: "google",
            displayName: "Google",
            status: "static",
            profiles: [
              authProfile("google:manual-api-key", "api_key", "static", {
                logoutSupported: true,
              }),
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
      await captureProviderProof("02-probed.png", page.locator('[data-provider-id="google"]'));
      await page.reload();
      await expect.poll(() => modelPickerValue(primary)).toBe("anthropic/claude-sonnet-4-5");
    });
  });

  it("autosaves utility choices without a primary model and retains them after reload", async () => {
    await suite.withPage(videoPageOptions(1280, 1000, artifactDir), async ({ page }) => {
      let config: unknown = { agents: { defaults: {} } };
      let hash = "utility-defaults";
      const snapshot = () => configSnapshot(config, hash);
      const gateway = await installMockGateway(page, {
        models: [catalogModel("openai", "gpt-5-mini", "GPT-5 Mini")],
        methodResponses: {
          "config.get": snapshot(),
          "models.authStatus": { ts: NOW, providers: [] },
          ...emptyUsage(NOW),
        },
      });
      const observations: unknown[] = [];
      try {
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const defaults = page.locator(".model-providers__defaults");
        const utility = page.locator("openclaw-select-picker:has(#model-providers-utility-model)");
        await expect.poll(() => modelPickerValue(utility)).toBe("__openclaw_automatic_utility__");
        await captureProviderProof("utility-before.png", utility);
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
          observations.push({
            choice,
            request,
            config,
            selected: await modelPickerValue(utility),
          });
          await captureProviderProof(`utility-${choice.label}-saved.png`, utility);
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
          await captureProviderProof(`utility-${choice.label}-reloaded.png`, utility);
        }
      } finally {
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
      }
    });
  });

  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    await suite.withPage(videoPageOptions(1280, 1000, artifactDir), async ({ page }) => {
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
              readyProvider("openai", "OpenAI", [authProfile("openai:writer", "oauth", "ok")]),
            ],
          },
          ...emptyUsage(NOW),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
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
      await captureProviderProof(
        "05-reconnect-save-error.png",
        page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }),
      );
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
      await captureProviderProof("06-reconnected-model.png", primary);
    });
  });
});
