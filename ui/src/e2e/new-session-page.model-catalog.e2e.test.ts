// Covers model-catalog metadata failure and recovery on the new-session page.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledGatewayUrl } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  NEW_SESSION_MODEL_CATALOG,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

function catalogDiscoveryRequests(
  requests: Array<{ params?: unknown }>,
): Array<{ params?: unknown }> {
  return requests.filter(
    ({ params }) =>
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as { metadataOnly?: unknown }).metadataOnly === true,
  );
}

suite.define(() => {
  it("separates model shortcuts, search input, and composer typing by focus", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await installMockGateway(page, { models: NEW_SESSION_MODEL_CATALOG });
        await page.goto(`${suite.server.baseUrl}new`);

        const modelSelect = page.locator('[data-chat-model-select="true"]');
        const picker = page.locator(".chat-controls__model-picker");
        const search = page.locator('[data-chat-model-search="true"]');
        const firstModel = page.locator('[data-chat-model-option="openai/gpt-5.5"]');
        const secondModel = page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]');

        await modelSelect.click();
        await expect.poll(() => picker.getAttribute("open")).toBe("");
        await expect
          .poll(() => modelSelect.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await revealChatModelOption(firstModel);
        await revealChatModelOption(secondModel);
        await modelSelect.focus();
        const secondShortcut = secondModel.locator('[data-chat-model-shortcut-number="2"]');
        await expect.poll(() => secondShortcut.count()).toBe(1);
        // Finish the picker's opening scale before recording its baseline. The top
        // transform origin keeps the anchor gap stable while box geometry still grows.
        await picker
          .locator(':scope > wa-popup[data-anchored-overlay] > [part~="popup"]')
          .evaluate(finishElementAnimations);
        const menuGeometry = () =>
          page.evaluate(() => {
            const anchor = document.querySelector('[data-chat-model-select="true"]');
            const menu = document.querySelector(".chat-controls__model-menu");
            const action = document.querySelector(
              '[data-chat-model-option="anthropic/claude-sonnet-4-6"] .chat-controls__model-option-action',
            );
            if (!anchor || !menu || !action) {
              return null;
            }
            const anchorBox = anchor.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            const actionBox = action.getBoundingClientRect();
            return {
              anchorGap: Math.round(anchorBox.top - menuBox.bottom),
              menu: {
                dx: menuBox.x - anchorBox.x,
                dy: menuBox.y - anchorBox.y,
                width: menuBox.width,
                height: menuBox.height,
              },
              action: {
                dx: actionBox.x - menuBox.x,
                dy: actionBox.y - menuBox.y,
                width: actionBox.width,
                height: actionBox.height,
              },
            };
          });
        await expect.poll(async () => (await menuGeometry())?.anchorGap).toBe(6);
        const geometryBeforeFocus = await menuGeometry();
        expect(geometryBeforeFocus).not.toBeNull();
        await expect
          .poll(() => secondShortcut.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");

        await search.focus();
        await expect
          .poll(() => search.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await expect
          .poll(() => secondShortcut.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("0");
        await expect.poll(menuGeometry).toEqual(geometryBeforeFocus);
        await search.press("1");
        await expect.poll(() => search.inputValue()).toBe("1");
        await expect.poll(() => picker.getAttribute("open")).toBe("");

        await search.fill("anthropic");
        await expect.poll(() => firstModel.isVisible()).toBe(false);
        await expect.poll(() => secondModel.isVisible()).toBe(true);
        await modelSelect.focus();
        const filteredShortcut = secondModel.locator('[data-chat-model-shortcut-number="1"]');
        await expect
          .poll(() => filteredShortcut.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await page.keyboard.press("1");
        await expect.poll(() => picker.getAttribute("open")).toBe(null);
        await expect.poll(() => modelSelect.textContent()).toContain("Claude Sonnet 4.6");

        await modelSelect.focus();
        await page.keyboard.type("1");
        await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("1");
      },
    );
  });
  it.each([false, true])(
    "does not repair saved cloud placement from retained display with identity %s",
    async (identity) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl))}`;
      const preference = { where: { kind: "cloud", id: "sample-cloud" } };
      const model: ModelCatalogEntry = {
        id: "one",
        name: "Retained one",
        provider: "fixture",
        available: true,
        agentRuntime: { id: "sample-runtime", cloudPlacementSupported: false, source: "model" },
      };
      const gateway = await installMockGateway(page, {
        agentModel: "fixture/one",
        models: [model, { ...model, id: "two", name: "Retained two" }],
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        ...(identity
          ? { presenceUsers: [{ id: "person-a", name: "Sample Person", self: true }] }
          : {}),
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          ...(identity ? ["users.prefs.get", "users.prefs.set"] : []),
        ],
        methodResponses: {
          "users.prefs.get": { status: "ok", entries: { "new-session.migration.v1": true } },
          "agents.list": {
            agents: [
              {
                id: "main",
                model: { primary: "fixture/one" },
                agentRuntime: {
                  id: "sample-runtime",
                  cloudPlacementSupported: true,
                  source: "agent",
                },
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [{ id: "sample-cloud", providerId: "crabbox" }],
          },
          "sessions.catalog.list": { catalogs: [] },
        },
      });
      const root = page.locator("openclaw-new-session-page");
      try {
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await expect.poll(() => root.locator("[data-chat-model-option]").count()).toBe(2);
        await navigateInApp(page, "agents-home");
        await expect.poll(() => root.count()).toBe(0);
        await page.evaluate(
          ({ key, value }) =>
            localStorage.setItem(key, JSON.stringify({ agents: { main: value } })),
          { key: storageKey, value: preference },
        );
        if (identity) {
          await gateway.setMethodResponse("users.prefs.get", {
            status: "ok",
            entries: { "new-session.migration.v1": true, "new-session.v1:main": preference },
          });
          await gateway.emitGatewayEvent("users.prefs.changed", { profileId: "person-a" });
        }
        const reads = (await gateway.getRequests("models.list")).length;
        await gateway.deferNext("models.list");
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await navigateInApp(page, "new-session", "?agent=main");
        await expect
          .poll(async () => (await gateway.getRequests("models.list")).length)
          .toBe(reads + 1);
        await root.locator("#new-session-where-trigger").click();
        await expect
          .poll(() => root.getByRole("button", { name: "sample-cloud", exact: true }).isVisible())
          .toBe(true);
        expect(await root.locator("[data-chat-model-option]").count()).toBe(2);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
        expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(
          JSON.stringify({ agents: { main: preference } }),
        );
        expect(
          await root.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"),
        ).toBe("sample-cloud");
        await page.keyboard.press("Escape");
        await root.locator('.new-session-page__composer [data-chat-model-select="true"]').click();
        await selectChatModelOption(root.locator('[data-chat-model-option="fixture/one"]'));
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
        await root.locator("#new-session-where-trigger").click();
        expect(
          await root.getByRole("button", { name: "sample-cloud", exact: true }).isDisabled(),
        ).toBe(false);
        await page.keyboard.press("Escape");
        await root.locator('.new-session-page__composer [data-chat-model-select="true"]').click();
        await selectChatModelOption(root.locator('[data-chat-model-option="fixture/two"]'));
        await root.locator("#new-session-where-trigger").click();
        await expect
          .poll(() => root.getByRole("button", { name: "sample-cloud", exact: true }).isDisabled())
          .toBe(true);
        const selectionWrites = (await gateway.getRequests("users.prefs.set")).length;
        await gateway.resolveDeferred("models.list", {
          models: [
            {
              ...model,
              name: "Accepted one",
              agentRuntime: { ...model.agentRuntime, cloudPlacementSupported: true },
            },
            { ...model, id: "two", name: "Accepted two" },
          ],
        });
        await expect
          .poll(() => root.locator('[data-chat-model-option="fixture/one"]').textContent())
          .toContain("Accepted one");
        expect(
          await root.locator("#new-session-where-trigger").getAttribute("data-cloud-profile"),
        ).toBe("sample-cloud");
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(selectionWrites);
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    { width: 1280, height: 900, identity: true },
    { width: 390, height: 844, identity: false },
  ])(
    "retains New Session choices during remount revalidation at $width pixels",
    async ({ width, height, identity }) => {
      const context = await suite.browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width, height },
      });
      const page = await context.newPage();
      const models = ["one", "two"].map((id) => ({
        id,
        name: `Retained ${id}`,
        provider: "fixture",
        available: true,
      }));
      const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl))}`;
      const gateway = await installMockGateway(page, {
        agentModel: "fixture/one",
        models,
        ...(identity
          ? { presenceUsers: [{ id: "person-a", name: "Sample Person", self: true }] }
          : {}),
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          ...(identity ? ["users.prefs.get", "users.prefs.set"] : []),
        ],
        methodResponses: {
          "users.prefs.get": { status: "ok", entries: { "new-session.migration.v1": true } },
          "sessions.catalog.list": { catalogs: [] },
        },
      });
      const root = page.locator("openclaw-new-session-page");
      const trigger = root.locator('.new-session-page__composer [data-chat-model-select="true"]');
      const rows = root.locator("[data-chat-model-option]");
      const preference = { model: "fixture/three" };
      try {
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await expect.poll(() => rows.count()).toBe(2);
        const reads = (await gateway.getRequests("models.list")).length;
        await navigateInApp(page, "agents-home");
        await expect.poll(() => root.count()).toBe(0);
        await navigateInApp(page, "new-session", "?agent=main");
        await expect.poll(() => rows.count()).toBe(2);
        expect(await gateway.getRequests("models.list")).toHaveLength(reads);
        await navigateInApp(page, "agents-home");
        await expect.poll(() => root.count()).toBe(0);
        await page.evaluate(
          ({ key, value }) =>
            localStorage.setItem(key, JSON.stringify({ agents: { main: value } })),
          { key: storageKey, value: preference },
        );
        if (identity) {
          await gateway.setMethodResponse("users.prefs.get", {
            status: "ok",
            entries: { "new-session.migration.v1": true, "new-session.v1:main": preference },
          });
          await gateway.emitGatewayEvent("users.prefs.changed", { profileId: "person-a" });
        }
        await gateway.deferNext("models.list");
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await navigateInApp(page, "new-session", "?agent=main");
        await expect
          .poll(async () => (await gateway.getRequests("models.list")).length)
          .toBe(reads + 1);
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => root.locator(".chat-controls__model-menu").isVisible()).toBe(true);
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `retained-${width}-pending.png`),
          });
        }
        await expect.poll(() => rows.count()).toBe(2);
        expect(await gateway.getRequests("connect")).toHaveLength(1);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
        const stored = await page.evaluate((key) => localStorage.getItem(key), storageKey);
        expect(JSON.parse(stored!).agents.main).toEqual(preference);
        const search = root.getByRole("combobox", { name: "Search models" });
        await search.fill("Retained");
        const composer = root.locator(".new-session-page__composer");
        const before = await composer.boundingBox();
        await gateway.resolveDeferred("models.list", {
          models: [models[0], { ...models[1], id: "three", name: "Retained three" }],
        });
        await expect
          .poll(() => root.locator('[data-chat-model-option="fixture/three"]').count())
          .toBe(1);
        expect(await root.locator('[data-chat-model-option="fixture/two"]').count()).toBe(0);
        expect(await search.inputValue()).toBe("Retained");
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        const menu = await root.locator(".chat-controls__model-menu").boundingBox();
        expect(menu).not.toBeNull();
        expect(menu!.x).toBeGreaterThanOrEqual(0);
        expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
        expect(menu!.y).toBeGreaterThanOrEqual(0);
        expect(menu!.y + menu!.height).toBeLessThanOrEqual(height);
        expect(await composer.boundingBox()).toEqual(before);
        expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `retained-${width}-replacement.png`),
          });
        }
        await page.keyboard.press("Escape");
        expect(await search.inputValue()).toBe("");
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await search.isVisible()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );

  it("selects fetched models while the next catalog request stays held", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "fixture/one",
      models: ["one", "two"].map((id) => ({
        id,
        name: `Retained ${id}`,
        provider: "fixture",
        available: true,
      })),
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator('.new-session-page__composer [data-chat-model-select="true"]');
      await expect.poll(() => trigger.textContent()).toContain("Retained one");
      const reads = (await gateway.getRequests("models.list")).length;
      await gateway.deferNext("models.list");
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect
        .poll(async () => (await gateway.getRequests("models.list")).length)
        .toBe(reads + 1);
      await trigger.click();
      await page.getByRole("combobox", { name: "Search models" }).fill("Retained");
      await page.locator('[data-chat-model-option="fixture/two"]').click();
      await expect.poll(() => trigger.textContent()).toContain("Retained two");
      expect(await trigger.getAttribute("aria-busy")).toBe("false");
      expect(await gateway.getRequests("models.list")).toHaveLength(reads + 1);
      if (captureUiProof) {
        await trigger.click();
        await page.getByRole("combobox", { name: "Search models" }).fill("Retained");
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "selected-during-held-refresh.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("starts with a usable retained account despite a refresh failure and leaves the default cleared", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const accountFitsMenu = () =>
      page.locator("[data-chat-account-selection]").evaluate((section) => {
        const menu = section.closest(".chat-controls__model-menu")!;
        const bounds = menu.getBoundingClientRect();
        const accountBounds = section.getBoundingClientRect();
        return (
          accountBounds.width > 0 &&
          accountBounds.left >= bounds.left &&
          accountBounds.right <= bounds.right
        );
      });
    const account = {
      authProfileId: "personal:person-a:anthropic:one",
      provider: "anthropic",
      label: "Test Person · Personal account",
      authType: "token",
      selected: false,
    };
    const model = {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      available: true,
    };
    const preview = {
      refreshFailed: true,
      models: [model],
      accountSelection: {
        kind: "personal",
        authProfileId: account.authProfileId,
        label: account.label,
        source: "user",
      },
    };
    const gateway = await installMockGateway(page, {
      agentModel: "anthropic/claude-haiku-4-5",
      presenceUsers: [{ id: "person-a", name: "Test Person", self: true }],
      models: [{ ...model, available: false, unavailableReason: "missing-auth" }],
      methodResponses: {
        "users.listModelAccounts": { profileId: "person-a", accounts: [account], links: [] },
        "models.list": {
          cases: [
            { match: { authProfileId: account.authProfileId }, response: preview },
            {
              match: {},
              response: {
                commands: [],
                models: [{ ...model, available: false, unavailableReason: "missing-auth" }],
                accountSelection: { kind: "automatic", label: "Automatic" },
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:personal-account", runStarted: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.locator(".new-session-page__message").fill("Start with this saved account");
      const start = page.getByRole("button", { name: "Start session" });
      const startHint = start.locator("..");
      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("true");
      const modelTrigger = page.locator('[data-chat-model-select="true"]');
      await modelTrigger.click();
      const picker = page.locator("[data-chat-account-selection]");
      const accountTrigger = picker.locator("[data-chat-account-group-toggle]");
      await expect.poll(() => accountTrigger.isEnabled()).toBe(true);
      await expect
        .poll(() => page.locator(".chat-controls__model-picker").textContent())
        .toContain("No models available");
      await expect.poll(accountFitsMenu).toBe(true);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "personal-account-01-no-default.png"),
        });
      }
      await accountTrigger.click();
      await gateway.deferNext("models.list", { authProfileId: account.authProfileId });
      await picker.locator(`[data-chat-account-option="account:${account.authProfileId}"]`).click();
      await expect.poll(() => startHint.getAttribute("content")).toBe("Loading models…");
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      await gateway.rejectDeferred("models.list", { code: "UNAVAILABLE", message: "Try again" });
      await expect.poll(() => startHint.getAttribute("content")).toBe("Models unavailable");
      expect(await start.getAttribute("aria-disabled")).toBe("true");

      await modelTrigger.click();
      await modelTrigger.click();
      await expect.poll(() => accountTrigger.textContent()).toContain(account.label);
      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
      await expect.poll(() => page.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      await expect.poll(accountFitsMenu).toBe(true);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "personal-account-02-selected.png"),
        });
      }
      await accountTrigger.click();
      await picker.getByText("Automatic (new-chat default)", { exact: true }).click();
      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("true");
      await expect.poll(() => accountTrigger.textContent()).toContain("Automatic");
      await accountTrigger.click();
      await gateway.deferNext("models.list", { authProfileId: account.authProfileId });
      await picker.locator(`[data-chat-account-option="account:${account.authProfileId}"]`).click();
      await expect.poll(() => startHint.getAttribute("content")).toBe("Loading models…");
      await gateway.rejectDeferred("models.list", { code: "UNAVAILABLE", message: "Try again" });
      await expect.poll(() => startHint.getAttribute("content")).toBe("Models unavailable");
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      await accountTrigger.click();
      await picker.locator(`[data-chat-account-option="account:${account.authProfileId}"]`).click();
      await expect.poll(() => start.getAttribute("aria-disabled")).toBe("false");
      await page.keyboard.press("Escape");
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "Start with this saved account",
        model: `anthropic/claude-haiku-4-5@${account.authProfileId}`,
      });
      expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(0);
      expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("accepts a draft while keeping the default hidden until model metadata arrives", async () => {
    if (captureUiProof) {
      await mkdir(path.join(suite.artifactDir, "new-session-skeleton-gap"), { recursive: true });
    }
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      heldMethods: ["models.list"],
      models: [
        {
          available: true,
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          reasoning: true,
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const modelTrigger = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await expect.poll(() => modelTrigger.getAttribute("aria-busy")).toBe("true");
      expect(await modelTrigger.getAttribute("aria-label")).toContain("Loading models…");
      expect(await modelTrigger.textContent()).not.toContain("gpt-5.6-luna");
      expect(await page.locator(".chat-controls__model-trigger-skeleton").count()).toBe(1);
      await page
        .locator(".new-session-page__message")
        .fill("Start without waiting for the catalog");
      await expect
        .poll(() =>
          page.getByRole("button", { name: "Start session" }).getAttribute("aria-disabled"),
        )
        .toBe("false");
      const actions = page.locator(".new-session-page__composer .agent-chat__composer-actions");
      const loadingModelBox = await modelTrigger.boundingBox();
      const loadingActionsBox = await actions.boundingBox();
      expect(loadingModelBox).not.toBeNull();
      expect(loadingActionsBox).not.toBeNull();
      expect(
        (loadingActionsBox?.x ?? 0) - ((loadingModelBox?.x ?? 0) + (loadingModelBox?.width ?? 0)),
      ).toBeLessThan(16);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(path.join(suite.artifactDir, "new-session-skeleton-gap"), "after.png"),
        });
      }

      await gateway.resolveDeferred("models.list");
      await expect.poll(() => modelTrigger.textContent()).toContain("GPT-5.6 Luna");
      expect(await modelTrigger.getAttribute("aria-busy")).toBe("false");
      const effortPicker = page.locator(
        ".new-session-page__composer .chat-controls__effort-picker:not(.chat-controls__effort-picker--reserved)",
      );
      await expect.poll(() => effortPicker.isVisible()).toBe(true);
      const readyActionsBox = await actions.boundingBox();
      expect(readyActionsBox).not.toBeNull();
      expect(readyActionsBox?.x).toBeCloseTo(loadingActionsBox?.x ?? 0, 0);
      expect(readyActionsBox?.width).toBeCloseTo(loadingActionsBox?.width ?? 0, 0);
      await modelTrigger.click();
      await page.keyboard.press("Escape");
      await modelTrigger.click();
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("selects a context window before creating a session", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      methodResponses: {
        "sessions.create": { key: "agent:main:context-window", runStarted: true },
      },
      models: [
        {
          available: true,
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
        },
        {
          available: true,
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await modelSelect.click();
      await selectChatModelOption(
        page.locator('[data-chat-model-option="anthropic/claude-fable-5"]'),
      );
      await modelSelect.click();

      const contextWindowToggle = page.locator('[data-chat-context-window-toggle="200k"]');
      await expect.poll(() => contextWindowToggle.isVisible()).toBe(true);
      expect(await contextWindowToggle.getAttribute("aria-checked")).toBe("true");
      await contextWindowToggle.click();
      await expect
        .poll(() => page.locator("[data-chat-model-context-badge]").textContent())
        .toContain("200K");

      await page.locator(".new-session-page__message").fill("use the smaller window");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "use the smaller window",
        model: "anthropic/claude-fable-5",
        contextWindow: "200k",
      });
    } finally {
      await context.close();
    }
  });

  it("shows metadata failure truthfully and recovers when the picker opens", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const models = [
      {
        available: true,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      },
      {
        available: true,
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        provider: "openai",
      },
    ];
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-luna",
      methodResponses: {
        "models.list": {
          sequence: [
            {
              __mockError: {
                code: "UNAVAILABLE",
                message: "metadata request timed out",
              },
            },
            { commands: [], models },
          ],
        },
      },
      models,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list");

      const modelSelect = page.locator('[data-chat-model-select="true"]');
      await expect.poll(() => modelSelect.getAttribute("title")).toBe("Models unavailable");
      expect(await page.locator("[data-chat-model-option]").count()).toBe(0);

      await modelSelect.click();

      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      expect((await gateway.getRequests("models.list"))[1]?.params).toMatchObject({
        agentId: "main",
      });
      await expect.poll(() => page.locator("[data-chat-model-option]").count()).toBe(3);
      expect(await page.locator("[data-chat-model-catalog-state]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("restores the model picker when startup publishes its catalog", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const recoveredModel = {
      available: true,
      id: "gpt-5.6-luna",
      name: "Recovered GPT-5.6 Luna",
      provider: "openai",
      reasoning: true,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "models.list": {
          __mockError: {
            code: "UNAVAILABLE",
            details: { reason: "startup-sidecars" },
            message: "gateway startup sidecars are still initializing",
            retryable: true,
            retryAfterMs: 100,
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list");
      await expect
        .poll(() => page.getByText("Models unavailable", { exact: true }).count())
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(2);
      await gateway.setMethodResponse("models.list", { commands: [], models: [recoveredModel] });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(3);

      const modelSelect = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await expect.poll(() => modelSelect.getAttribute("aria-disabled")).toBe("false");
      await modelSelect.click();
      await expect
        .poll(() => page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').textContent())
        .toContain(recoveredModel.name);

      expect(await gateway.getRequests("models.list")).toHaveLength(3);
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).toEqual({ view: "configured", agentId: "main" });
      }
    } finally {
      await context.close();
    }
  });

  it("recovers a failed CLI-agent catalog without reloading model metadata for its retry", async () => {
    if (captureUiProof) {
      await mkdir(path.join(suite.artifactDir, "new-session-catalog-retry"), { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "new-session-catalog-retry"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const models = [
      {
        available: true,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
      },
    ];
    const unavailable = {
      __mockError: {
        code: "UNAVAILABLE",
        message: "CLI-agent catalog is warming",
      },
    };
    const discoveryMatch = { agentId: "main", metadataOnly: true };
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [
        "models.list",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            { match: discoveryMatch, response: unavailable },
            { match: {}, response: { catalogs: [] } },
          ],
        },
      },
      models,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(1);

      await page.locator('[data-chat-model-select="true"]').click();

      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(2);
      const errorState = page.locator(
        '[data-chat-model-target-group="cliAgents"] [data-chat-model-catalog-state="error"]',
      );
      await expect.poll(() => errorState.isVisible()).toBe(true);
      await pollLocatorText(
        errorState.locator(".chat-controls__model-catalog-state-label > span"),
      ).toBe("CLI agents unavailable");
      const retry = page.locator('[data-chat-model-target-retry="cliAgents"]');
      await expect.poll(() => retry.isEnabled()).toBe(true);
      await pollLocatorText(retry).toContain("Retry");
      await pollLocatorText(
        page.locator(
          '[data-chat-model-option="openai/gpt-5.6-luna"] .chat-controls__model-option-name',
        ),
      ).toBe("GPT-5.6 Luna");
      expect(await page.getByText("Models unavailable", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "new-session-catalog-retry", "01-cli-agents-retry.png"),
          await takeControlUiViewportScreenshot(
            page,
            page.locator('.chat-controls__model-picker wa-popup [part="popup"]'),
            [errorState],
          ),
        );
      }

      await gateway.setMethodResponse("sessions.catalog.list", {
        cases: [
          {
            match: discoveryMatch,
            response: {
              catalogs: [
                {
                  id: "anthropic",
                  label: "Claude Code",
                  capabilities: {
                    continueSession: false,
                    archive: false,
                    startTerminal: true,
                  },
                  hosts: [],
                },
              ],
            },
          },
          { match: {}, response: { catalogs: [] } },
        ],
      });
      await retry.click();

      await expect
        .poll(async () =>
          catalogDiscoveryRequests(await gateway.getRequests("sessions.catalog.list")),
        )
        .toHaveLength(3);
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
      await expect
        .poll(() => page.locator('[data-chat-model-target="anthropic"]').isVisible())
        .toBe(true);
      await pollLocatorText(
        page.locator(
          '[data-chat-model-target-group="cliAgents"] .chat-controls__provider-heading > span:last-child',
        ),
      ).toBe("CLI agents");
      await pollLocatorText(
        page.locator('[data-chat-model-target="anthropic"] .chat-controls__model-option-name'),
      ).toBe("Claude Code");
      expect(await errorState.count()).toBe(0);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "new-session-catalog-retry", "02-cli-agents-recovered.png"),
          await takeControlUiViewportScreenshot(
            page,
            page.locator('.chat-controls__model-picker wa-popup [part="popup"]'),
            [page.locator('[data-chat-model-target="anthropic"]')],
          ),
        );
      }
    } finally {
      await context.close();
    }
  });
});
