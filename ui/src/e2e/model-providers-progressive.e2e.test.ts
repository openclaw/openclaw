import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol/frame-guards";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalogModel, configAuth } from "./model-catalog-fixtures.test-support.ts";
import { requestRaw, resolveConfigMutation } from "./model-providers.test-support.ts";
import {
  expectText,
  expectCount,
  setupPages,
  setupContext,
} from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI progressive Model Providers loading",
  startServerBeforeBrowser: true,
});
const withPage = setupPages(suite, setupContext);
const snapshot = (config: object, hash: string) => ({
  config,
  sourceConfig: config,
  hash,
  raw: JSON.stringify(config),
  valid: true,
});
const model = (id: string, name: string, provider = "fixture") => catalogModel(provider, id, name);
const defaultsConfig = (modelRef: string) => ({ agents: { defaults: { model: modelRef } } });
const option = (picker: Locator, value: string) =>
  picker.locator(`[role="option"][data-value="${value}"]`);
function defaultPicker(page: Page) {
  const defaults = page.locator(".model-providers__defaults");
  const picker = defaults.locator("openclaw-select-picker").first();
  return { defaults, picker, trigger: picker.locator(".picker-select__trigger") };
}
suite.define(() => {
  it("reuses a pending Models snapshot until discovery publishes completion", async () => {
    await withPage(async ({ page }) => {
      const currentModel = model("current", "Current model");
      const pendingCatalog = { models: [currentModel], pendingProviders: ["fixture"] };
      const gateway = await installMockGateway(page, {
        connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
        defaultAgentId: "main",
        deferredMethods: ["agents.list"],
        models: [currentModel],
        methodResponses: {
          "models.list": pendingCatalog,
          "models.authStatus": {
            ts: 1,
            providers: [configAuth("fixture")],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/model-providers");
      await gateway.waitForRequest("agents.list");
      const connect = await gateway.waitForRequest("connect");
      const target = asNullableRecord(connect.params)?.modelCatalog;
      expect(target).toBeDefined();
      await gateway.emitGatewayEvent("models.snapshot", {
        target,
        scope: { agentId: "main" },
        catalog: pendingCatalog,
      });
      const reads = (await gateway.getRequests("models.list")).length;
      expect(reads).toBe(0);
      await gateway.resolveDeferred("agents.list");
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      const badge = page.locator(
        '[data-provider-id="fixture"] .model-providers__head .settings-status',
      );
      await expect.poll(() => badge.textContent()).toBe("Checking models…");
      expect(await gateway.getRequests("models.list")).toHaveLength(reads);
      await gateway.setMethodResponse("models.list", {
        models: [currentModel],
        pendingProviders: [],
        providerOutcomes: [{ provider: "fixture", status: "ready" }],
      });
      await gateway.emitGatewayEvent("chat.metadata.changed", {
        modelCatalogChanged: true,
        authChanged: false,
        commandsChanged: false,
      });
      await expect.poll(() => badge.textContent()).toBe("Ready");
      expect((await gateway.getRequests("models.list")).length).toBe(reads + 1);
      await page.locator('a[href="/settings/appearance"]').first().click();
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await page.locator('a[href="/settings/model-providers"]').first().click();
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      expect(await badge.textContent()).toBe("Ready");
      expect((await gateway.getRequests("models.list")).map((request) => request.params)).toEqual([
        { view: "configured", agentId: "main" },
        { view: "configured", preparedOnly: true, agentId: "main" },
      ]);
    });
  });

  it.each(["fresh", "populated", "empty"] as const)(
    "adopts partial provider inventory on the Models route (%s cache)",
    async (cacheState) => {
      await withPage(async ({ page }) => {
        const initialConfig = defaultsConfig("healthy/anchor");
        const savedConfig = defaultsConfig("healthy/current");
        const partial: ModelCatalogResult = {
          models:
            cacheState === "empty"
              ? []
              : [
                  model("current", "Healthy current", "healthy"),
                  model("returned", "Returned sibling", "broken"),
                ],
          refreshFailed: true,
          providerOutcomes: [
            { provider: "healthy", status: "ready" },
            { provider: "broken", status: "unavailable" },
          ],
          defaultModels: {
            automaticUtilityModel: cacheState === "empty" ? null : "healthy/current",
          },
          pendingProviders: [],
        };
        const initialCatalog: ModelCatalogResult =
          cacheState === "fresh"
            ? partial
            : {
                models: [
                  model("retired", "Retired healthy", "healthy"),
                  model("retired", "Retired sibling", "broken"),
                ],
                defaultModels: { automaticUtilityModel: "healthy/retired" },
              };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          models: initialCatalog.models,
          methodResponses: {
            "config.get": snapshot(initialConfig, "initial"),
            "config.patch": { ok: true, config: savedConfig, hash: "saved" },
            "models.list": initialCatalog,
            "models.authStatus": {
              ts: 1,
              providers: ["healthy", "broken"].map(configAuth),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const settings = page.locator("openclaw-model-providers-page");
        const { defaults, picker, trigger } = defaultPicker(page);
        await trigger.click();
        if (cacheState !== "fresh") {
          await option(picker, "healthy/retired").waitFor();
          await gateway.setMethodResponse("models.list", partial);
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
        }
        // The failing provider's row reports the gap; the defaults card does not repeat it.
        await expect
          .poll(() =>
            settings.locator('[data-provider-id="broken"] .model-providers__head').textContent(),
          )
          .toContain("Models unavailable");
        expect(
          await settings.locator('.model-providers__catalog-progress[role="alert"]').count(),
        ).toBe(0);
        expect(
          await settings
            .locator('[data-provider-id="healthy"] .model-providers__head')
            .textContent(),
        ).not.toContain("Models unavailable");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        await expectCount(option(picker, "healthy/retired"), 0);
        expect(await option(picker, "broken/retired").count()).toBe(0);
        const utility = defaults.locator("#model-providers-utility-model");
        if (cacheState === "empty") {
          expect(await option(picker, "healthy/current").count()).toBe(0);
          expect(await utility.textContent()).not.toContain("Retired healthy");
          await trigger.click();
        } else {
          const current = option(picker, "healthy/current");
          await current.waitFor({ state: "visible" });
          expect(await current.getAttribute("aria-disabled")).not.toBe("true");
          expect(await option(picker, "broken/returned").isVisible()).toBe(true);
          expect(await utility.textContent()).toContain("Auto · Healthy current");
          await gateway.setMethodResponse("config.get", snapshot(savedConfig, "saved"));
          await gateway.deferNext("config.patch");
          await current.click();
          await gateway.waitForRequest("config.patch");
          await expect.poll(() => trigger.isEnabled()).toBe(false);
          await gateway.resolveDeferred("config.patch");
          await expect.poll(() => trigger.isEnabled()).toBe(true);
          expect(await trigger.textContent()).toContain("Healthy current");
          expect(await defaults.getByText("Defaults saved.", { exact: true }).count()).toBe(0);
        }
        const recovered: ModelCatalogResult = {
          models: [
            model("recovered", "Healthy recovered", "healthy"),
            model("recovered", "Sibling recovered", "broken"),
          ],
          providerOutcomes: [
            { provider: "healthy", status: "ready" },
            { provider: "broken", status: "ready" },
          ],
          defaultModels: { automaticUtilityModel: "healthy/recovered" },
          pendingProviders: [],
        };
        await gateway.setMethodResponse("models.list", recovered);
        await gateway.deferNext("models.list", { refresh: true });
        const refreshes = (await gateway.getRequests("models.list", { refresh: true })).length;
        // Provider access refresh retries discovery for the failing provider.
        await settings.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("models.list", { after: refreshes, match: { refresh: true } });
        await trigger.click();
        await gateway.resolveDeferred("models.list", recovered);
        await picker
          .locator('[role="option"][data-value="healthy/recovered"]')
          .waitFor({ state: "visible" });
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(
          await settings
            .locator('[data-provider-id="broken"] .model-providers__head')
            .textContent(),
        ).not.toContain("Models unavailable");
        expect(await utility.textContent()).toContain("Auto · Healthy recovered");
      });
    },
  );

  it("keeps the current Models catalog after late route data and invalidation", async () => {
    await withPage(async ({ page }) => {
      const initial = defaultsConfig("fixture/initial");
      const saved = defaultsConfig("fixture/chosen");
      const models = [model("initial", "Initial model"), model("chosen", "Chosen model")];
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        deferredMethods: ["models.authStatus", "config.patch"],
        models,
        methodResponses: {
          "models.list": {
            models,
            defaultModels: { automaticUtilityModel: "fixture/initial" },
            pendingProviders: ["obsolete-provider"],
          },
          "config.get": snapshot(initial, "initial-settings"),
          "models.authStatus": { ts: 1, providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await gateway.waitForRequest("config.get");
      await evaluateControlUiContext(page, async (application) => {
        const route = (application.router as ApplicationRouter).getRoute("model-providers");
        if (!route) {
          throw new Error("Models route is unavailable");
        }
        await route.component();
      });
      await page.locator('a[href="/settings/model-providers"]').first().click();
      await gateway.waitForRequest("models.authStatus");
      const defaults = page.locator(".model-providers__defaults");
      await defaults.waitFor({ state: "visible" });
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await trigger.click();
      await option(picker, "fixture/chosen").click();
      expect(requestRaw(await gateway.waitForRequest("config.patch"))).toMatchObject({
        agents: { defaults: { model: "fixture/chosen" } },
      });
      const currentCatalog: ModelCatalogResult = {
        models: [models[1]!, model("added", "Added model")],
        defaultModels: { automaticUtilityModel: "fixture/chosen" },
      };
      await gateway.setMethodResponse("models.list", currentCatalog);
      await resolveConfigMutation(gateway, saved, "saved-settings");
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await pickerValue(picker)).toBe("fixture/chosen");
      await trigger.click();
      await expect.poll(() => option(picker, "fixture/added").isVisible()).toBe(true);
      await gateway.resolveDeferred("models.authStatus");
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      expect(await pickerValue(picker)).toBe("fixture/chosen");
      expect(await option(picker, "fixture/added").isVisible()).toBe(true);
      expect(await option(picker, "fixture/initial").count()).toBe(0);
      const reads = (await gateway.getRequests("models.list")).length;
      await gateway.deferNext("models.list");
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect
        .poll(async () => (await gateway.getRequests("models.list")).length)
        .toBe(reads + 1);
      expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      expect(await option(picker, "fixture/initial").count()).toBe(0);
      expect(await option(picker, "fixture/added").isVisible()).toBe(true);
      expect(await pickerValue(picker)).toBe("fixture/chosen");
      expect(await page.locator(".model-providers__catalog-progress").count()).toBe(0);
      await gateway.resolveDeferred("models.list");
    });
  });

  it("keeps Models defaults unavailable after a replacement connection fails to read config", async () => {
    await withPage(async ({ page }) => {
      const previous = defaultsConfig("fixture/previous");
      const current = defaultsConfig("fixture/current");
      const previousModel = model("previous", "Previous connection model");
      const currentModels = [model("current", "Current connection model")];
      const gateway = await installMockGateway(page, {
        connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
        defaultAgentId: "main",
        models: [previousModel],
        methodResponses: {
          "models.list": { models: [previousModel] },
          "config.get": snapshot(previous, "previous-settings"),
          "models.authStatus": { ts: 1, providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      const { defaults, picker, trigger } = defaultPicker(page);
      await expect.poll(() => pickerValue(picker)).toBe("fixture/previous");
      await expect.poll(() => trigger.isEnabled()).toBe(true);

      const configReads = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.get");
      await gateway.setMethodResponse("config.get", {
        __mockError: { code: "UNAVAILABLE", message: "Current config is unavailable." },
      });
      await gateway.setMethodResponse("models.list", {
        models: currentModels,
        defaultModels: { automaticUtilityModel: "fixture/current" },
      });
      await evaluateControlUiContext(page, (application) => {
        application.gateway.connect();
      });
      await gateway.waitForRequest("config.get", { after: configReads });
      await gateway.emitGatewayEvent("models.snapshot", {
        target: {},
        scope: { agentId: "main" },
        catalog: {
          models: currentModels,
          defaultModels: { automaticUtilityModel: "fixture/current" },
        },
      });
      await gateway.rejectDeferred("config.get", { message: "Current config is unavailable." });
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (application) => application.runtimeConfig.state.lastError,
          ),
        )
        .toContain("Current config is unavailable.");
      await trigger.click();
      const currentOption = option(picker, "fixture/current");
      expect(await currentOption.getAttribute("aria-disabled")).toBe("true");
      await currentOption.click({ force: true });
      await trigger.click();
      expect(await pickerValue(picker)).toBe("");
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Current connection model",
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await gateway.setMethodResponse("config.get", snapshot(current, "current-settings"));
      await page.locator(".model-providers__refresh-button").click();
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await expect.poll(() => pickerValue(picker)).toBe("fixture/current");
      await trigger.click();
      expect(await option(picker, "fixture/previous").count()).toBe(0);
    });
  });

  it("unlocks Models editing when Refresh supersedes the initial config read", async () => {
    await withPage(async ({ page }) => {
      const config = defaultsConfig("fixture/current");
      const models = [model("current", "Current model")];
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        models,
        heldMethods: ["config.get"],
        methodResponses: {
          "models.list": { models },
          "models.authStatus": { ts: 1, providers: [] },
          "config.get": snapshot(config, "current-settings"),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      await gateway.waitForRequest("config.get");
      const { picker, trigger } = defaultPicker(page);
      await trigger.click();
      const currentOption = option(picker, "fixture/current");
      expect(await currentOption.getAttribute("aria-disabled")).toBe("true");
      await currentOption.click({ force: true });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await trigger.click();
      const configReads = (await gateway.getRequests("config.get")).length;
      await page.locator(".model-providers__refresh-button").click();
      await gateway.waitForRequest("config.get", { after: configReads });
      await gateway.resolveDeferred("config.get");
      await expectText(trigger, "Current model");
      await expect
        .poll(() => page.locator(".model-providers__refresh-button").isEnabled())
        .toBe(true);
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await trigger.click();
      await expect.poll(() => option(picker, "fixture/current").isVisible()).toBe(true);
    });
  });

  it.each(["snapshot", "ordinary"] as const)(
    "opens the Models route from %s catalog publication and refreshes after overlapping reads",
    async (publicationKind) => {
      await withPage(async ({ page }) => {
        const prepared = model("prepared", "Prepared model");
        const older = { ...prepared, id: "older", name: "Older model" };
        const added = { ...prepared, id: "added", name: "New model" };
        const gateway = await installMockGateway(page, {
          ...(publicationKind === "snapshot"
            ? { connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT] }
            : {}),
          defaultAgentId: "main",
          models: [older],
          heldMethods: ["models.list", "models.authStatus", "usage.status"],
          methodResponses: {
            "config.get": {
              config: defaultsConfig("fixture/prepared"),
              hash: "prepared-settings-model",
              valid: true,
            },
            "models.authStatus": { ts: 1, providers: [] },
          },
        });
        if (publicationKind === "snapshot") {
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        } else {
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        }
        // Appearance can start a prepared-only read before navigation. Release the
        // held catalog only after the Models page has admitted its own projection.
        const routeCatalogRequests = async () =>
          (await gateway.getRequests("models.list")).filter(
            (request) => asNullableRecord(request.params)?.preparedOnly !== true,
          );
        await expect.poll(async () => (await routeCatalogRequests()).length).toBe(1);
        const publication = {
          target: {},
          scope: { agentId: "main" },
          catalog: {
            models: [prepared],
            defaultModels: { automaticUtilityModel: "fixture/prepared" },
          },
        };
        if (publicationKind === "snapshot") {
          await gateway.emitGatewayEvent("models.snapshot", publication);
        } else {
          await gateway.resolveDeferred("models.list", publication.catalog);
        }
        const { picker, trigger } = defaultPicker(page);
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await trigger.click();
        const preparedRow = option(picker, "fixture/prepared");
        await expect.poll(() => preparedRow.isVisible()).toBe(true);
        await expectText(preparedRow, "Prepared model");
        expect(await preparedRow.isEnabled()).toBe(true);
        expect(await routeCatalogRequests()).toHaveLength(1);

        await gateway.resolveDeferred("models.authStatus");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");

        if (publicationKind === "snapshot") {
          await gateway.resolveDeferred("models.list", { models: [older] });
        }
        await expect.poll(() => preparedRow.isVisible()).toBe(true);

        const beforeRefresh = await gateway.deferNext("models.list", { refresh: true });
        await page.locator(".model-providers__refresh-button").click();
        const refreshed = await gateway.waitForRequest("models.list", {
          after: beforeRefresh,
          match: { refresh: true },
        });
        expect(refreshed.params).toMatchObject({ agentId: "main", refresh: true });
        await gateway.resolveDeferred("models.list", {
          models: [prepared, added],
          defaultModels: { automaticUtilityModel: "fixture/added" },
        });
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        await expect.poll(() => option(picker, "fixture/added").isVisible()).toBe(true);
        expect(await picker.locator('[data-value="fixture/older"]').count()).toBe(0);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      });
    },
  );

  it.each(["cold", "prewarmed", "cached"] as const)(
    "renders provider controls before provider usage settles (%s module)",
    async (moduleState) => {
      await withPage(
        async ({ page }) => {
          const now = Date.now();
          const gateway = await installMockGateway(page, {
            models: [model("gpt-5.5", "GPT-5.5", "openai")],
            heldMethods:
              moduleState === "cached"
                ? []
                : ["usage.status", ...(moduleState === "cold" ? ["models.authStatus"] : [])],
            methodResponses: {
              "config.get": {
                config: defaultsConfig("openai/gpt-5.5"),
                sourceConfig: {},
                hash: "progressive-model-providers",
                issues: [],
                raw: "{}",
                valid: true,
              },
              "models.authStatus": {
                ts: now,
                providers: [
                  {
                    provider: "openai",
                    displayName: "OpenAI",
                    status: "static",
                    profiles: [],
                    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
                  },
                ],
              },
              "usage.status": {
                updatedAt: now,
                providers: [
                  { provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] },
                ],
              },
              "sessions.usage": {
                aggregates: {
                  byProvider: [
                    {
                      provider: "openai",
                      count: 1,
                      totals: { totalTokens: 100, totalCost: 1.25 },
                    },
                  ],
                },
              },
            },
          });

          const previousLoads = moduleState === "cached" ? 1 : 0;
          let previousAuthLoads = 0;
          if (moduleState === "cached") {
            await page.goto(`${suite.server.baseUrl}settings/appearance`);
            await waitForControlUiRoute(page, { routeId: "appearance" });
            await page.locator('a[href="/settings/model-providers"]').first().click();
            await waitForControlUiRoute(page, { routeId: "model-providers" });
            await expectText(
              page.locator('[data-provider-id="openai"] .provider-row__plan'),
              "Pro",
            );
            await page.locator('a[href="/settings/appearance"]').first().click();
            await waitForControlUiRoute(page, { routeId: "appearance" });
            await gateway.deferNext("usage.status");
          }
          if (moduleState !== "cold") {
            if (moduleState === "prewarmed") {
              await page.goto(`${suite.server.baseUrl}settings/appearance`);
            }
            await waitForControlUiRoute(page, { routeId: "appearance" });
            await gateway.deferNext("models.authStatus");
            previousAuthLoads = (await gateway.getRequests("models.authStatus")).length;
            if (moduleState === "cached") {
              await gateway.emitGatewayEvent("chat.metadata.changed", {});
            }
            await evaluateControlUiContext(page, async (application) => {
              const route = (application.router as ApplicationRouter).getRoute("model-providers");
              if (!route) {
                throw new Error("Models route is unavailable");
              }
              await route.component();
            });
            await page.locator('a[href="/settings/model-providers"]').first().click();
          } else {
            expect(
              (await page.goto(`${suite.server.baseUrl}settings/model-providers`))?.status(),
            ).toBe(200);
          }
          if (moduleState === "cold") {
            await gateway.waitForRequest("models.authStatus");
          } else {
            await expect
              .poll(async () => (await gateway.getRequests("models.authStatus")).length)
              .toBeGreaterThan(previousAuthLoads);
          }
          await page.locator("openclaw-model-providers-page").waitFor();
          if (moduleState === "cached") {
            await expectText(page.locator('[data-provider-id="openai"]'), "Credentials configured");
          }
          expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads);
          expect(await gateway.getRequests("sessions.usage")).toHaveLength(0);
          await gateway.resolveDeferred("models.authStatus");
          await waitForControlUiRoute(page, { routeId: "model-providers" });
          await gateway.waitForRequest("usage.status");
          const provider = page.locator('[data-provider-id="openai"]');
          await provider.waitFor();
          await expectText(provider, "Credentials configured");
          expect(await provider.locator(".provider-row__plan").count()).toBe(0);
          expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
          expect(await gateway.getRequests("sessions.usage")).toHaveLength(0);

          await gateway.resolveDeferred("usage.status");
          await expectText(provider.locator(".provider-row__plan"), "Pro");
          expect(await provider.textContent()).not.toContain("$1.25");
          expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
          expect(await gateway.getRequests("sessions.usage")).toHaveLength(0);
          expect(await page.locator('[data-provider-id="unknown-provider"]').count()).toBe(0);
        },
        {
          viewport: { height: 1_000, width: 1_280 },
        },
      );
    },
  );
});
