import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationRouter } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir(
      "model-providers-progressive",
      process.env.OPENCLAW_UI_E2E_PROOF_DIR,
    );
  }
});

describeControlUiE2e("Control UI progressive Model Providers loading", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

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

  it.each(["fresh", "populated", "empty"] as const)(
    "adopts partial provider inventory on the Models route (%s cache)",
    async (cacheState) => {
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const initialConfig = { agents: { defaults: { model: "healthy/anchor" } } };
      const savedConfig = { agents: { defaults: { model: "healthy/current" } } };
      const snapshot = (config: typeof initialConfig, hash: string) => ({
        config,
        sourceConfig: config,
        hash,
        raw: JSON.stringify(config),
        valid: true,
      });
      const partial: ModelCatalogResult = {
        models:
          cacheState === "empty"
            ? []
            : [
                { provider: "healthy", id: "current", name: "Healthy current", available: true },
                { provider: "broken", id: "returned", name: "Returned sibling", available: true },
              ],
        refreshFailed: true,
        providerOutcomes: [
          { provider: "healthy", status: "ready" },
          { provider: "broken", status: "unavailable" },
        ],
        defaultModels: { automaticUtilityModel: cacheState === "empty" ? null : "healthy/current" },
        pendingProviders: [],
      };
      const initialCatalog: ModelCatalogResult =
        cacheState === "fresh"
          ? partial
          : {
              models: [
                { provider: "healthy", id: "retired", name: "Retired healthy", available: true },
                { provider: "broken", id: "retired", name: "Retired sibling", available: true },
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
            providers: ["healthy", "broken"].map((provider) => ({
              provider,
              profiles: [],
              apiKey: { source: "config" },
            })),
          },
        },
      });
      const capture = async (stage: string) => {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, `partial-${cacheState}-${stage}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".model-providers__defaults"),
            ]),
          );
        }
      };
      try {
        await page.goto(`${server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const settings = page.locator("openclaw-model-providers-page");
        const defaults = settings.locator(".model-providers__defaults");
        const picker = defaults.locator("openclaw-select-picker").first();
        const trigger = picker.locator(".picker-select__trigger");
        await trigger.click();
        if (cacheState !== "fresh") {
          await picker.locator('[role="option"][data-value="healthy/retired"]').waitFor();
          await gateway.setMethodResponse("models.list", partial);
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
        }
        const warning = settings.locator('.model-providers__catalog-progress[role="alert"]');
        await expect
          .poll(() => warning.textContent())
          .toContain("More models could not be discovered.");
        await expect
          .poll(() =>
            settings.locator('[data-provider-id="broken"] .model-providers__head').textContent(),
          )
          .toContain("Models unavailable");
        expect(
          await settings
            .locator('[data-provider-id="healthy"] .model-providers__head')
            .textContent(),
        ).not.toContain("Models unavailable");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        await expect
          .poll(() => picker.locator('[role="option"][data-value="healthy/retired"]').count())
          .toBe(0);
        expect(await picker.locator('[role="option"][data-value="broken/retired"]').count()).toBe(
          0,
        );
        const utility = defaults.locator("#model-providers-utility-model");
        if (cacheState === "empty") {
          expect(
            await picker.locator('[role="option"][data-value="healthy/current"]').count(),
          ).toBe(0);
          expect(await utility.textContent()).not.toContain("Retired healthy");
          await capture("returned");
          await trigger.click();
        } else {
          const current = picker.locator('[role="option"][data-value="healthy/current"]');
          await current.waitFor({ state: "visible" });
          expect(await current.getAttribute("aria-disabled")).not.toBe("true");
          expect(
            await picker.locator('[role="option"][data-value="broken/returned"]').isVisible(),
          ).toBe(true);
          expect(await utility.textContent()).toContain("Auto · Healthy current");
          await capture("returned");
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
            { provider: "healthy", id: "recovered", name: "Healthy recovered", available: true },
            { provider: "broken", id: "recovered", name: "Sibling recovered", available: true },
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
        await warning.getByRole("button", { name: "Retry", exact: true }).click();
        await gateway.waitForRequest("models.list", { after: refreshes, match: { refresh: true } });
        await trigger.click();
        await gateway.resolveDeferred("models.list", recovered);
        await picker
          .locator('[role="option"][data-value="healthy/recovered"]')
          .waitFor({ state: "visible" });
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => warning.count()).toBe(0);
        expect(
          await settings
            .locator('[data-provider-id="broken"] .model-providers__head')
            .textContent(),
        ).not.toContain("Models unavailable");
        expect(await utility.textContent()).toContain("Auto · Healthy recovered");
      } finally {
        await capture("settled");
        await context.close();
      }
    },
  );

  it("keeps a Models route selection saved before the initial provider details arrive", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = { agents: { defaults: { model: "fixture/initial" } } };
    const saved = { agents: { defaults: { model: "fixture/chosen" } } };
    const models = [
      { id: "initial", name: "Initial model", provider: "fixture", available: true },
      { id: "chosen", name: "Chosen model", provider: "fixture", available: true },
    ];
    const snapshot = (config: typeof initial, hash: string) => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
    });
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      deferredMethods: ["models.authStatus", "config.patch"],
      models,
      methodResponses: {
        "models.list": { models, defaultModels: { automaticUtilityModel: "fixture/initial" } },
        "config.get": snapshot(initial, "initial-settings"),
        "models.authStatus": { ts: 1, providers: [] },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await gateway.waitForRequest("config.get");
      await page.evaluate(async () => {
        const app = document.querySelector<
          HTMLElement & { runtime: { router: ApplicationRouter } }
        >("openclaw-app");
        const route = app?.runtime.router.getRoute("model-providers");
        if (!route) {
          throw new Error("Models route is unavailable");
        }
        await route.component();
      });
      await page.locator('a[href="/settings/model-providers"]').first().click();
      await gateway.waitForRequest("models.authStatus");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement & { loaderPending: boolean }>(
                "openclaw-model-providers-page",
              )?.loaderPending,
          ),
        )
        .toBe(true);
      const defaults = page.locator(".model-providers__defaults");
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await trigger.click();
      await picker.locator('[role="option"][data-value="fixture/chosen"]').click();
      await gateway.waitForRequest("config.patch");
      await gateway.setMethodResponse("config.get", snapshot(saved, "saved-settings"));
      await gateway.setMethodResponse("models.list", {
        models: [
          ...models,
          { id: "added", name: "Added model", provider: "fixture", available: true },
        ],
        defaultModels: { automaticUtilityModel: "fixture/chosen" },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: saved,
        hash: "saved-settings",
      });
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await defaults.getByText("Defaults saved.", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("models.authStatus");
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await trigger.textContent()).toContain("Chosen model");
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Chosen model",
      );
      await trigger.click();
      await expect
        .poll(() => picker.locator('[role="option"][data-value="fixture/added"]').isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps the current Models catalog after late route data and invalidation", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initial = { agents: { defaults: { model: "fixture/initial" } } };
    const saved = { agents: { defaults: { model: "fixture/chosen" } } };
    const models = [
      { id: "initial", name: "Initial model", provider: "fixture", available: true },
      { id: "chosen", name: "Chosen model", provider: "fixture", available: true },
    ];
    const snapshot = (config: typeof initial, hash: string) => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
    });
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
    try {
      await page.goto(`${server.baseUrl}settings/appearance`);
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await gateway.waitForRequest("config.get");
      await page.evaluate(async () => {
        const app = document.querySelector<
          HTMLElement & { runtime: { router: ApplicationRouter } }
        >("openclaw-app");
        const route = app?.runtime.router.getRoute("model-providers");
        if (!route) {
          throw new Error("Models route is unavailable");
        }
        await route.component();
      });
      await page.locator('a[href="/settings/model-providers"]').first().click();
      await gateway.waitForRequest("models.authStatus");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement & { loaderPending: boolean }>(
                "openclaw-model-providers-page",
              )?.loaderPending,
          ),
        )
        .toBe(true);
      const defaults = page.locator(".model-providers__defaults");
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await trigger.click();
      await picker.locator('[role="option"][data-value="fixture/chosen"]').click();
      await gateway.waitForRequest("config.patch");
      await gateway.setMethodResponse("config.get", snapshot(saved, "saved-settings"));
      await gateway.setMethodResponse("models.list", {
        models: [
          models[1]!,
          { id: "added", name: "Added model", provider: "fixture", available: true },
        ],
        defaultModels: { automaticUtilityModel: "fixture/chosen" },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: saved,
        hash: "saved-settings",
      });
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await defaults.getByText("Defaults saved.", { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("models.authStatus");
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await trigger.textContent()).toContain("Chosen model");
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Chosen model",
      );
      await trigger.click();
      await expect
        .poll(() => picker.locator('[role="option"][data-value="fixture/added"]').isVisible())
        .toBe(true);
      expect(await picker.locator('[role="option"][data-value="fixture/initial"]').count()).toBe(0);
      const reads = (await gateway.getRequests("models.list")).length;
      await gateway.deferNext("models.list");
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect
        .poll(async () => (await gateway.getRequests("models.list")).length)
        .toBe(reads + 1);
      expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      expect(await picker.locator('[role="option"][data-value="fixture/initial"]').count()).toBe(0);
      expect(await picker.locator('[role="option"][data-value="fixture/added"]').isVisible()).toBe(
        true,
      );
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Chosen model",
      );
      expect(await page.locator(".model-providers__catalog-progress").count()).toBe(0);
      if (recordVisuals) {
        await writeFile(
          path.join(artifactDir, "catalog-invalidated-current.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [defaults]),
        );
      }
      await gateway.resolveDeferred("models.list");
    } finally {
      await context.close();
    }
  });

  it("keeps Models defaults unavailable after a replacement connection fails to read config", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const previous = { agents: { defaults: { model: "fixture/previous" } } };
    const current = { agents: { defaults: { model: "fixture/current" } } };
    const saved = { agents: { defaults: { model: "fixture/chosen" } } };
    const previousModel = {
      id: "previous",
      name: "Previous connection model",
      provider: "fixture",
      available: true,
    };
    const currentModels = [
      { id: "current", name: "Current connection model", provider: "fixture", available: true },
      { id: "chosen", name: "Chosen model", provider: "fixture", available: true },
    ];
    const snapshot = (config: typeof previous, hash: string) => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
    });
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      models: [previousModel],
      methodResponses: {
        "models.list": { models: [previousModel] },
        "config.get": snapshot(previous, "previous-settings"),
        "models.authStatus": { ts: 1, providers: [] },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      const defaults = page.locator(".model-providers__defaults");
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await expect.poll(() => trigger.textContent()).toContain("Previous connection model");
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
      await page.evaluate(() => {
        const app = document.querySelector<
          HTMLElement & { runtime: { context: ApplicationContext } }
        >("openclaw-app");
        if (!app) {
          throw new Error("Application is unavailable");
        }
        app.runtime.context.gateway.connect();
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
          page.evaluate(() => {
            const app = document.querySelector<
              HTMLElement & { runtime: { context: ApplicationContext } }
            >("openclaw-app");
            return app?.runtime.context.runtimeConfig.state.lastError;
          }),
        )
        .toContain("Current config is unavailable.");
      if (recordVisuals) {
        await writeFile(
          path.join(artifactDir, "config-replacement-unavailable.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [defaults]),
        );
      }
      await expect.poll(() => trigger.isEnabled()).toBe(false);
      expect(await trigger.textContent()).not.toContain("Previous connection model");
      expect(await defaults.locator("#model-providers-utility-model").textContent()).toContain(
        "Auto · Current connection model",
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await gateway.setMethodResponse("config.get", snapshot(current, "current-settings"));
      await page.locator(".model-providers__refresh-button").click();
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await expect.poll(() => trigger.textContent()).toContain("Current connection model");
      await trigger.click();
      expect(await picker.locator('[role="option"][data-value="fixture/previous"]').count()).toBe(
        0,
      );
      await gateway.deferNext("config.patch");
      await gateway.deferNext("config.get");
      await picker.locator('[role="option"][data-value="fixture/chosen"]').click();
      await gateway.waitForRequest("config.patch");
      const savedConfigReads = (await gateway.getRequests("config.get")).length;
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: saved,
        hash: "saved-settings",
      });
      await gateway.waitForRequest("config.get", { after: savedConfigReads });
      await gateway.rejectDeferred("config.get", { message: "Saved config could not refresh." });
      await expect.poll(() => defaults.textContent()).toContain("Saved config could not refresh.");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await trigger.textContent()).toContain("Chosen model");
      expect(await defaults.getByText("Defaults saved.", { exact: true }).count()).toBe(0);
      if (recordVisuals) {
        await writeFile(
          path.join(artifactDir, "config-save-warning-editable.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [defaults]),
        );
      }
    } finally {
      await context.close();
    }
  });

  it("unlocks Models editing when Refresh supersedes the initial config read", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const config = { agents: { defaults: { model: "fixture/current" } } };
    const models = [{ id: "current", name: "Current model", provider: "fixture", available: true }];
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      models,
      heldMethods: ["config.get"],
      methodResponses: {
        "models.list": { models },
        "models.authStatus": { ts: 1, providers: [] },
        "config.get": {
          config,
          sourceConfig: config,
          hash: "current-settings",
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, { routeId: "model-providers" });
      await gateway.waitForRequest("config.get");
      const defaults = page.locator(".model-providers__defaults");
      const picker = defaults.locator("openclaw-select-picker").first();
      const trigger = picker.locator(".picker-select__trigger");
      await expect.poll(() => trigger.isEnabled()).toBe(false);
      const configReads = (await gateway.getRequests("config.get")).length;
      await page.locator(".model-providers__refresh-button").click();
      await gateway.waitForRequest("config.get", { after: configReads });
      await gateway.resolveDeferred("config.get");
      await expect.poll(() => trigger.textContent()).toContain("Current model");
      await expect
        .poll(() => page.locator(".model-providers__refresh-button").isEnabled())
        .toBe(true);
      if (recordVisuals) {
        await writeFile(
          path.join(artifactDir, "config-overlapping-refresh-settled.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [defaults]),
        );
      }
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await trigger.click();
      await expect
        .poll(() => picker.locator('[role="option"][data-value="fixture/current"]').isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it.each(["snapshot", "ordinary"] as const)(
    "opens the Models route from %s catalog publication while auth is pending",
    async (publicationKind) => {
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const prepared = {
        id: "prepared",
        name: "Prepared model",
        provider: "fixture",
        available: true,
      };
      const older = { ...prepared, id: "older", name: "Older model" };
      const added = { ...prepared, id: "added", name: "New model" };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        models: [older],
        heldMethods: ["models.list", "models.authStatus", "usage.status", "sessions.usage"],
        methodResponses: {
          "config.get": {
            config: { agents: { defaults: { model: "fixture/prepared" } } },
            hash: "prepared-settings-model",
            valid: true,
          },
          "models.authStatus": { ts: 1, providers: [] },
        },
      });
      try {
        if (publicationKind === "snapshot") {
          await page.goto(`${server.baseUrl}settings/model-providers`);
        } else {
          await page.goto(`${server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        }
        await gateway.waitForRequest("models.list");
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
        const picker = page.locator(".model-providers__defaults openclaw-select-picker").first();
        const trigger = picker.locator(".picker-select__trigger");
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await trigger.click();
        const preparedRow = picker.locator('[role="option"][data-value="fixture/prepared"]');
        await expect.poll(() => preparedRow.isVisible()).toBe(true);
        await expect.poll(() => preparedRow.textContent()).toContain("Prepared model");
        expect(await preparedRow.isEnabled()).toBe(true);
        expect(await gateway.getRequests("models.list")).toHaveLength(1);

        await gateway.resolveDeferred("models.authStatus");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");

        if (publicationKind === "snapshot") {
          await gateway.resolveDeferred("models.list", { models: [older] });
        }
        await expect.poll(() => preparedRow.isVisible()).toBe(true);
        expect(await picker.locator('[data-value="fixture/older"]').count()).toBe(0);

        await gateway.deferNext("models.list");
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        await gateway.resolveDeferred("models.list", {
          models: [prepared, added],
          defaultModels: { automaticUtilityModel: "fixture/added" },
        });
        await expect
          .poll(() => picker.locator('[role="option"][data-value="fixture/added"]').isVisible())
          .toBe(true);
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await context.close();
      }
    },
  );

  it.each(["cold", "prewarmed", "cached"] as const)(
    "renders provider controls before usage and cost settle (%s module)",
    async (moduleState) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_280 },
        ...(recordVisuals
          ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_280 } } }
          : {}),
      });
      const page = await context.newPage();
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        heldMethods:
          moduleState === "cached"
            ? []
            : [
                "usage.status",
                "sessions.usage",
                ...(moduleState === "cold" ? ["models.authStatus"] : []),
              ],
        methodResponses: {
          "config.get": {
            config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
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
            providers: [{ provider: "openai", displayName: "OpenAI", plan: "Pro", windows: [] }],
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

      try {
        const previousLoads = moduleState === "cached" ? 1 : 0;
        let previousAuthLoads = 0;
        if (moduleState === "cached") {
          await page.goto(`${server.baseUrl}settings/appearance`);
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await page.locator('a[href="/settings/model-providers"]').first().click();
          await waitForControlUiRoute(page, { routeId: "model-providers" });
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("$1.25");
          await page.locator('a[href="/settings/appearance"]').first().click();
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await gateway.deferNext("usage.status");
          await gateway.deferNext("sessions.usage");
        }
        if (moduleState !== "cold") {
          if (moduleState === "prewarmed") {
            await page.goto(`${server.baseUrl}settings/appearance`);
          }
          await waitForControlUiRoute(page, { routeId: "appearance" });
          await gateway.deferNext("models.authStatus");
          previousAuthLoads = (await gateway.getRequests("models.authStatus")).length;
          await page.evaluate(async () => {
            const app = document.querySelector<
              HTMLElement & { runtime: { router: ApplicationRouter } }
            >("openclaw-app");
            const route = app?.runtime.router.getRoute("model-providers");
            if (!route) {
              throw new Error("Models route is unavailable");
            }
            await route.component();
          });
          await page.locator('a[href="/settings/model-providers"]').first().click();
        } else {
          expect((await page.goto(`${server.baseUrl}settings/model-providers`))?.status()).toBe(
            200,
          );
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
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Credentials configured");
          await expect
            .poll(() => page.locator('[data-provider-id="openai"]').textContent())
            .toContain("Loading");
        }
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "route-pending.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads);
        await gateway.resolveDeferred("models.authStatus");
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await gateway.waitForRequest("usage.status");
        await gateway.waitForRequest("sessions.usage");
        const provider = page.locator('[data-provider-id="openai"]');
        await provider.waitFor();
        await expect.poll(async () => provider.textContent()).toContain("Credentials configured");
        await expect.poll(async () => provider.textContent()).toContain("Loading");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "before.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("usage.status");
        await expect.poll(async () => provider.textContent()).toContain("Pro");
        expect(await provider.textContent()).not.toContain("$1.25");
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "usage-ready.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }

        await gateway.resolveDeferred("sessions.usage");
        await expect.poll(async () => provider.textContent()).toContain("$1.25");
        expect(await gateway.getRequests("usage.status")).toHaveLength(previousLoads + 1);
        expect(await gateway.getRequests("sessions.usage")).toHaveLength(previousLoads + 1);
        expect(await page.locator('[data-provider-id="unknown-provider"]').count()).toBe(0);
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "after.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [provider]),
          );
        }
      } finally {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "final.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-model-providers-page"),
            ]),
          );
        }
        await context.close();
      }
    },
  );
});
