import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { importCustomThemeFromUrl } from "../pages/config/custom-theme-import.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";
import { pickerValue, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  configResponse,
  patchPrefs,
  resetSyncedPreference,
  waitForRequestCount,
} from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} satisfies Parameters<typeof suite.browser.newContext>[0];
const contextOptions = {
  ...pageOptions,
  colorScheme: "dark",
  viewport: { height: 1000, width: 1440 },
} satisfies Parameters<typeof suite.browser.newContext>[0];

async function openAppearance(page: Page, gateway: MockGatewayControls) {
  const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
  expect(response?.status()).toBe(200);
  await waitForControlUiSettingsTakeover(page);
  await gateway.waitForRequest("config.get");
}

function appearanceGateway(
  page: Page,
  prefs: Record<string, unknown>,
  hash: string,
  options: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    methodResponses: { "config.get": configResponse(prefs, hash), "config.patch": { ok: true } },
    ...options,
  });
}

function seedSettings(context: BrowserContext, values: Record<string, unknown>, seedOnce = false) {
  return context.addInitScript(
    ({ key, settings, once }) => {
      const seedKey = "openclaw.control-ui-e2e.appearance-defaults-seeded";
      if (once && sessionStorage.getItem(seedKey) === "1") {
        return;
      }
      if (once) {
        sessionStorage.setItem(seedKey, "1");
      }
      localStorage.setItem(key, JSON.stringify(settings));
    },
    {
      key: settingsStorageKey(),
      settings: { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), ...values },
      once: seedOnce,
    },
  );
}

async function delayedThemeRoute(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://tweakcn.com/r/themes/replacement", async (route) => {
    await gate;
    await route.fulfill({ json: createTweakcnThemePayload() });
  });
  return release;
}

function expectAttribute(locator: Locator, name: string, value: string) {
  return expect.poll(() => locator.getAttribute(name)).toBe(value);
}

function expectPressed(locator: Locator, value = "true") {
  return expectAttribute(locator, "aria-pressed", value);
}

function expectText(locator: Locator, text: string) {
  return expect.poll(() => locator.textContent()).toContain(text);
}

async function expectNoWrites(gateway: MockGatewayControls, ...methods: string[]) {
  for (const method of methods) {
    expect(await gateway.getRequests(method)).toHaveLength(0);
  }
}

function themeCard(page: Page, theme: string) {
  return page.locator(`#settings-appearance-theme .settings-theme-card--${theme}`);
}

async function expectDefaults(page: Page) {
  await expect
    .poll(() => pickerValue(settingsRow(page, "Language").locator("openclaw-select-picker")))
    .toBe("system");
  await expectPressed(themeCard(page, "claw"));
  await expect
    .poll(() =>
      settingsRow(page, "Color mode").getByRole("radiogroup").locator("input:checked").inputValue(),
    )
    .toBe("system");
  await expectPressed(
    page.locator("#settings-appearance-text-size .settings-text-scale__btn", { hasText: "100%" }),
  );
}

async function expectAccent(page: Page, accent: string, foreground: string) {
  await expect
    .poll(() => readAccentPresentation(page))
    .toEqual({
      accent,
      accentForeground: foreground,
      primaryForeground: foreground,
    });
}

async function rejectPreference(
  gateway: MockGatewayControls,
  click: () => Promise<unknown>,
  count: number,
  prefs: Record<string, unknown>,
) {
  await gateway.deferNext("config.patch");
  await click();
  await waitForRequestCount(gateway, "config.patch", count);
  expect(patchPrefs((await gateway.getRequests("config.patch"))[count - 1]!)).toEqual(prefs);
  await gateway.rejectDeferred("config.patch", {
    code: "INVALID_REQUEST",
    message: "mock validation failure",
  });
}

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("appearance-settings-defaults");
  }
});
function settingsStorageKey(): string {
  return controlUiBundledSettingsStorageKey(suite.server.baseUrl);
}

function settingsRow(page: Page, title: string): Locator {
  return page
    .locator(".settings-row")
    .filter({ has: page.locator(".settings-row__title", { hasText: title }) })
    .first();
}

async function readPersistedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }, settingsStorageKey());
}

async function readAccentPresentation(page: Page) {
  return page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      accent: styles.getPropertyValue("--accent").trim(),
      accentForeground: styles.getPropertyValue("--accent-foreground").trim(),
      primaryForeground: styles.getPropertyValue("--primary-foreground").trim(),
    };
  });
}

/** Resolves --primary-hover to concrete channels via a painted probe; computed
 * custom-property reads return the raw color-mix() expression, not a color. */
async function readResolvedPrimaryHover(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--primary-hover)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    // Chromium serializes mixed colors as color(srgb r g b) with 0-1 floats.
    const channels = (value.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    return channels.every((channel) => channel <= 1)
      ? channels.map((channel) => channel * 255)
      : channels;
  });
}

async function readThemeImportRaceState(page: Page) {
  const importer = page.locator(".settings-theme-import");
  const message = importer.locator(".settings-theme-import__message");
  const settings = await readPersistedSettings(page);
  return {
    renderedThemeMode: await page.locator("html").getAttribute("data-theme"),
    titleColor: await page
      .locator(".page-title")
      .evaluate((element) => getComputedStyle(element).color),
    clawSelected: (await themeCard(page, "claw").getAttribute("aria-pressed")) === "true",
    customThemeMetadataCount: await importer.locator(".settings-theme-import__meta").count(),
    importUrl: await importer.locator("input").inputValue(),
    message: (await message.count()) > 0 ? ((await message.textContent())?.trim() ?? "") : "",
    importButtonDisabled: await importer.locator("button.primary").isDisabled(),
    persistedTheme: settings.theme ?? null,
    hasPersistedCustomTheme: settings.customTheme !== undefined,
  };
}

async function captureViewport(page: Page, filename: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, filename),
  });
}

suite.define(() => {
  it("removes synced and browser-local overrides, then reloads inherited defaults", async () => {
    await suite.withPage(contextOptions, async ({ context, page }) => {
      await seedSettings(context, { textScale: 110 }, true);
      const initialPrefs = { locale: "en", theme: "knot", themeMode: "dark" };
      const gateway = await appearanceGateway(page, initialPrefs, "appearance-defaults-1");
      await openAppearance(page, gateway);
      const languageRow = settingsRow(page, "Language");
      const themeSection = page.locator("#settings-appearance-theme");
      const colorModeRow = settingsRow(page, "Color mode");
      const textSizeSection = page.locator("#settings-appearance-text-size");
      const languageSelect = languageRow.locator("openclaw-select-picker");
      const colorModeGroup = colorModeRow.getByRole("radiogroup");
      await expect.poll(() => pickerValue(languageSelect)).toBe("en");
      await expectPressed(themeCard(page, "knot"));
      await expect.poll(() => colorModeGroup.locator("input:checked").inputValue()).toBe("dark");
      await expectPressed(
        textSizeSection.locator(".settings-text-scale__btn", { hasText: "110%" }),
      );
      await expect.poll(() => languageRow.textContent()).toContain("Default: System");
      await expect.poll(() => themeSection.textContent()).toContain("Default: Claw");
      await expect.poll(() => colorModeRow.textContent()).toContain("Default: System");
      await expect.poll(() => textSizeSection.textContent()).toContain("Default: 100%");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "01-explicit-overrides.png");

      const resets = [
        [
          "locale",
          () => selectPickerValue(languageSelect, "system"),
          { theme: "knot", themeMode: "dark" },
        ],
        ["theme", () => themeCard(page, "claw").click(), { themeMode: "dark", accent: "theme" }],
        [
          "themeMode",
          () => colorModeRow.getByRole("radio", { name: "System", exact: true }).click(),
          { accent: "theme" },
        ],
      ] satisfies Array<[string, () => Promise<void>, Record<string, unknown>]>;
      for (const [index, [expectedKey, click, remainingPrefs]] of resets.entries()) {
        await resetSyncedPreference({
          click,
          expectedKey,
          gateway,
          remainingPrefs,
          hash: `appearance-defaults-${index + 2}`,
          ...(expectedKey === "theme" ? { expectedPrefs: { theme: null, accent: "theme" } } : {}),
        });
      }

      await textSizeSection.locator(".settings-text-scale__btn", { hasText: "100%" }).click();
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");
      await expectDefaults(page);
      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");
      await expectDefaults(page);
      for (const section of [languageRow, themeSection, colorModeRow, textSizeSection]) {
        await expect.poll(() => section.textContent()).not.toContain("Using default:");
      }
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "03-inherited-defaults.png");
    });
  });

  it("applies synced accent preferences immediately and restores the operator seam color", async () => {
    const localAccent = "#f5b942";
    const serverAccent = "#5b9cf6";
    const mintAccent = "#52c99a";
    const customAccent = "#243b6b";
    const operatorAccent = "#123456";
    await suite.withPage(contextOptions, async ({ context, page }) => {
      await seedSettings(context, { accent: localAccent });
      const initialPrefs = { accent: serverAccent, theme: "knot" };
      const gateway = await appearanceGateway(page, initialPrefs, "appearance-accent-1", {
        deferredMethods: ["config.get"],
      });
      await page.route("**/control-ui-config.json", (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), seamColor: operatorAccent },
        }),
      );

      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("config.get");
      await expectAccent(page, localAccent, "#000000");

      await gateway.resolveDeferred(
        "config.get",
        configResponse(initialPrefs, "appearance-accent-1"),
      );
      await waitForControlUiSettingsTakeover(page);
      const accentSection = page.locator("#settings-appearance-accent");
      const mintPreset = accentSection.locator('[data-accent-preset="mint"]');
      await expectPressed(accentSection.locator('[data-accent-preset="blue"]'));
      await expect.poll(() => readAccentPresentation(page)).toMatchObject({ accent: serverAccent });
      await accentSection.scrollIntoViewIfNeeded();
      await captureViewport(page, "08-accent-server-preference.png");

      await gateway.setMethodResponse(
        "config.get",
        configResponse({ accent: mintAccent, theme: "knot" }, "appearance-accent-2"),
      );
      await mintPreset.click();
      await waitForRequestCount(gateway, "config.patch", 1);
      expect(patchPrefs((await gateway.getRequests("config.patch"))[0]!)).toEqual({
        accent: mintAccent,
      });
      await expectPressed(mintPreset);
      await expectAccent(page, mintAccent, "#000000");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ accent: mintAccent });
      // Dark Knot primary buttons hover on --primary-hover; it must track the
      // selected accent (mint mixed 18% toward white), not the theme default.
      const hoverChannels = await readResolvedPrimaryHover(page);
      const expectedHover = [0x52, 0xc9, 0x9a].map((channel) =>
        Math.round(channel * 0.82 + 255 * 0.18),
      );
      expect(hoverChannels).toHaveLength(3);
      for (const [index, channel] of hoverChannels.entries()) {
        expect(Math.abs(channel - expectedHover[index]!)).toBeLessThanOrEqual(2);
      }
      await captureViewport(page, "09-accent-mint-selected.png");

      await resetSyncedPreference({
        click: () => themeCard(page, "claw").click(),
        expectedKey: "theme",
        expectedPrefs: { theme: null, accent: "theme" },
        gateway,
        hash: "appearance-accent-3",
        remainingPrefs: { accent: "theme" },
      });
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
      await expect.poll(() => readAccentPresentation(page)).toMatchObject({ accent: "#ff5c5c" });
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ accent: "theme" });
      await expectPressed(mintPreset, "false");

      await gateway.setMethodResponse(
        "config.get",
        configResponse({ accent: customAccent }, "appearance-accent-4"),
      );
      await accentSection.locator('input[type="color"][data-accent-custom]').fill(customAccent);
      await waitForRequestCount(gateway, "config.patch", 3);
      expect(patchPrefs((await gateway.getRequests("config.patch"))[2]!)).toEqual({
        accent: customAccent,
      });
      await expectAccent(page, customAccent, "#ffffff");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ accent: customAccent });

      await resetSyncedPreference({
        click: () => accentSection.locator('[data-accent-preset="default"]').click(),
        expectedKey: "accent",
        gateway,
        hash: "appearance-accent-5",
        remainingPrefs: {},
      });
      await expectPressed(accentSection.locator('[data-accent-preset="default"]'));
      await expectAccent(page, operatorAccent, "#ffffff");
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("accent");
      await captureViewport(page, "10-accent-operator-default-restored.png");
    });
  });

  it("keeps rejected edits browser-local and resets them without another server write", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const initialPrefs = { locale: "en", theme: "claw", chatFollowUpMode: "queue" };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse(initialPrefs, "appearance-rejected-1"),
        },
      });
      await openAppearance(page, gateway);
      const languageRow = page.locator("#settings-language .settings-row");
      const languageSelect = languageRow.locator("openclaw-select-picker");
      const themeSection = page.locator("#settings-appearance-theme");
      const themeDescription = themeSection.locator(":scope > .settings-section__desc");
      const followUpSelect = page.locator("[data-settings-follow-up-mode]");
      const followUpRow = page.locator(".settings-row").filter({ has: followUpSelect });
      await expect.poll(() => pickerValue(languageSelect)).toBe("en");
      await expectPressed(themeCard(page, "claw"));
      await expect.poll(() => followUpSelect.inputValue()).toBe("queue");

      await rejectPreference(gateway, () => themeCard(page, "knot").click(), 1, {
        theme: "knot",
        accent: "theme",
      });
      await expectPressed(themeCard(page, "knot"));
      await expect.poll(() => themeDescription.textContent()).toContain("Default: Claw");
      await expectText(themeDescription, "Stored in this browser only");

      await rejectPreference(gateway, () => selectPickerValue(languageSelect, "fr"), 2, {
        locale: "fr",
      });
      await expect.poll(() => pickerValue(languageSelect)).toBe("fr");
      await expect.poll(() => languageRow.textContent()).toContain("Par défaut : Anglais");
      await expectText(languageRow, "Stocké uniquement dans ce navigateur");

      await rejectPreference(gateway, () => followUpSelect.selectOption("steer"), 3, {
        chatFollowUpMode: "steer",
      });
      await expect.poll(() => followUpSelect.inputValue()).toBe("steer");
      await expectText(followUpRow, "Stocké uniquement dans ce navigateur");

      await themeSection.locator(".settings-theme-card--claw").click();
      await selectPickerValue(languageSelect, "system");
      await followUpRow.locator("button.btn--sm").click();
      await expectPressed(themeCard(page, "claw"));
      await expect.poll(() => pickerValue(languageSelect)).toBe("en");
      await expect.poll(() => followUpSelect.inputValue()).toBe("queue");
      await expectAttribute(page.locator("html"), "lang", "en");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(3);
    });
  });

  it("keeps every read-only preference surface browser-local across reload", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        methodResponses: {
          "config.get": configResponse({ theme: "knot" }, "appearance-read-only-1"),
        },
      });
      await openAppearance(page, gateway);
      const themeSection = page.locator("#settings-appearance-theme");
      const themeDescription = themeSection.locator(":scope > .settings-section__desc");
      await themeSection.locator(".settings-theme-card--claw").click();
      await expectPressed(themeCard(page, "claw"));
      await expectText(themeDescription, "Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ theme: "claw" });
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expectPressed(themeCard(page, "claw"));
      await expectText(themeDescription, "Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ theme: "claw" });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await themeSection.locator(".settings-theme-card--knot").click();
      await expectPressed(themeCard(page, "knot"));
      await expect.poll(() => themeDescription.textContent()).toContain("Default: Claw");
      await expect
        .poll(() => themeDescription.textContent())
        .not.toContain("Stored in this browser only");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}chat`);
      const viewMenuTrigger = page.locator(".chat-header-session-menu__trigger");
      await viewMenuTrigger.click();
      const viewMenu = page.locator(
        "openclaw-chat-header-session-menu > .chat-header-session-menu",
      );
      const viewItem = viewMenu.getByRole("menuitem", { name: "View", exact: true });
      await viewItem.hover();
      await expect
        .poll(() => viewMenu.locator('[role="note"]').textContent())
        .toContain("Stored in this browser only");
      const reasoning = viewMenu.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await expect.poll(() => reasoning.isVisible()).toBe(true);
      await reasoning.click();
      await expectAttribute(reasoning, "aria-checked", "false");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: "Pages", exact: true }).click();
      const usage = sidebar.locator(".sidebar-pages__entry").filter({
        has: page.locator('[data-sidebar-entry="route:usage"]'),
      });
      const pinnedUsage = sidebar.locator('.sidebar-rail__pin[data-sidebar-entry="route:usage"]');
      const pinsBefore = await sidebar
        .locator(".sidebar-rail__pin")
        .evaluateAll((pins) => pins.map((pin) => pin.getAttribute("data-sidebar-entry")));
      expect(await pinnedUsage.count()).toBe(0);
      await usage.getByRole("button", { name: "Pin", exact: true }).click();
      await pinnedUsage.getByRole("link", { name: "Usage", exact: true }).waitFor();
      await usage.getByRole("button", { name: "Unpin", exact: true }).waitFor();
      // Without a writable profile, personal navigation is browser-local, never global config.
      await expect
        .poll(() => readPersistedSettings(page))
        .toMatchObject({ railShortcuts: [...pinsBefore, "route:usage"] });
      await expectNoWrites(gateway, "config.patch", "users.prefs.set", "sessions.patch");

      await page.reload();
      await viewMenuTrigger.click();
      await viewItem.hover();
      await expect
        .poll(() => viewMenu.locator('[role="note"]').textContent())
        .toContain("Stored in this browser only");
      await expect
        .poll(() =>
          viewMenu
            .getByRole("menuitemcheckbox", { name: "Reasoning" })
            .getAttribute("aria-checked"),
        )
        .toBe("false");

      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await pinnedUsage.getByRole("link", { name: "Usage", exact: true }).waitFor();
      await sidebar.getByRole("button", { name: "Pages", exact: true }).click();
      await usage.getByRole("button", { name: "Unpin", exact: true }).waitFor();
      await expect
        .poll(() => readPersistedSettings(page))
        .toMatchObject({ railShortcuts: [...pinsBefore, "route:usage"] });
      await expectNoWrites(gateway, "config.patch", "users.prefs.set", "sessions.patch");
    });
  });

  it("announces a failed custom-theme import, then persists a successful retry across reload", async () => {
    await suite.withPage({ ...pageOptions, colorScheme: "dark" }, async ({ page }) => {
      const gateway = await appearanceGateway(page, {}, "custom-theme-invalid-1");
      await page.route("https://tweakcn.com/r/themes/network-failure", async (route) => {
        await route.fulfill({ status: 503 });
      });
      let successfulImports = 0;
      await page.route("https://tweakcn.com/r/themes/retry-theme", async (route) => {
        successfulImports += 1;
        await route.fulfill({ json: createTweakcnThemePayload() });
      });
      await openAppearance(page, gateway);
      await page.locator(".settings-theme-card--custom").click();
      const importer = page.locator(".settings-theme-import");
      await importer.locator("input").fill("https://tweakcn.com/themes/network-failure");
      await importer.locator("button.primary").click();
      await expect
        .poll(async () => (await importer.getByRole("alert").textContent())?.trim())
        .toBe("tweakcn import failed (503).");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await captureViewport(page, "07-custom-theme-import-error-announced.png");

      await gateway.setMethodResponse(
        "config.get",
        configResponse({ theme: "custom", accent: "theme" }, "custom-theme-imported-2"),
      );
      await importer.locator("input").fill("https://tweakcn.com/themes/retry-theme");
      await importer.locator("button.primary").click();
      await expectText(importer.getByRole("status"), "Imported");
      await expectAttribute(page.locator("html"), "data-theme", "custom");
      const importedSettings = await readPersistedSettings(page);
      expect(importedSettings).toMatchObject({
        customTheme: { themeId: "retry-theme", label: "Light Green" },
        theme: "custom",
      });
      const importedAccent = await readAccentPresentation(page);
      expect(importedAccent.accent).toBe(createTweakcnThemePayload().cssVars.dark.accent);
      await waitForRequestCount(gateway, "config.patch", 1);
      const [themePatch] = await gateway.getRequests("config.patch");
      expect(patchPrefs(themePatch!)).toEqual({ theme: "custom", accent: "theme" });
      await captureViewport(page, "08-custom-theme-imported.png");

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expectAttribute(page.locator("html"), "data-theme", "custom");
      await expectText(importer.locator(".settings-theme-import__meta-value"), "Light Green");
      expect((await readPersistedSettings(page)).customTheme).toEqual(importedSettings.customTheme);
      expect(await readAccentPresentation(page)).toEqual(importedAccent);
      expect(successfulImports).toBe(1);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await captureViewport(page, "09-custom-theme-reloaded.png");
    });
  });

  it("keeps Clear authoritative after a delayed custom-theme replacement", async () => {
    const existingTheme = await importCustomThemeFromUrl("existing", async () =>
      Response.json({ ...createTweakcnThemePayload(), name: "Existing Test Theme" }),
    );
    await suite.withPage(contextOptions, async ({ context, page }) => {
      await seedSettings(context, { customTheme: existingTheme, theme: "custom" });
      const gateway = await appearanceGateway(page, {}, "custom-theme-race-1");
      const releaseReplacement = await delayedThemeRoute(page);
      try {
        await openAppearance(page, gateway);
        const importer = page.locator(".settings-theme-import");
        const importField = importer.locator("input");
        await expectAttribute(page.locator("html"), "data-theme", "custom");
        await expectText(
          importer.locator(".settings-theme-import__meta-value"),
          "Existing Test Theme",
        );
        const beforeReplace = await readThemeImportRaceState(page);
        await captureViewport(page, "04-custom-theme-before-replace.png");

        await importField.fill("replacement");
        await importer.locator("button.primary").click();
        const replacementResponse = page.waitForResponse(
          "https://tweakcn.com/r/themes/replacement",
        );
        await expect.poll(() => importer.locator("button.primary").isDisabled()).toBe(true);
        await importer.locator("button.danger").click();
        await expectPressed(themeCard(page, "claw"));
        await expect.poll(() => importer.locator(".settings-theme-import__meta").count()).toBe(0);
        const afterClear = await readThemeImportRaceState(page);
        await captureViewport(page, "05-custom-theme-cleared-with-replace-pending.png");

        releaseReplacement();
        await replacementResponse;
        await expect
          .poll(async () => {
            const { customTheme, theme } = await readPersistedSettings(page);
            return { customTheme, theme };
          })
          .toEqual({ customTheme: undefined, theme: "claw" });
        await expect.poll(() => importer.locator(".settings-theme-import__meta").count()).toBe(0);
        await expectText(importer.locator(".settings-theme-import__message"), "removed");
        await expect.poll(() => importer.getByRole("status").count()).toBe(1);
        const afterDelayedResponse = await readThemeImportRaceState(page);
        expect(beforeReplace).toMatchObject({
          clawSelected: false,
          customThemeMetadataCount: 1,
          persistedTheme: "custom",
          hasPersistedCustomTheme: true,
        });
        expect(afterClear).toMatchObject({
          renderedThemeMode: "dark",
          clawSelected: true,
          customThemeMetadataCount: 0,
          importUrl: "replacement",
          importButtonDisabled: false,
          persistedTheme: "claw",
          hasPersistedCustomTheme: false,
        });
        expect(beforeReplace.titleColor).not.toBe(afterClear.titleColor);
        expect(afterDelayedResponse).toEqual({
          ...afterClear,
          message: "Custom theme removed.",
        });
        console.info(
          `[control-ui-e2e] THEME_IMPORT_RACE_VERDICT ${JSON.stringify({
            scenario: "delayed-replace-then-clear",
            beforeReplace,
            afterClear,
            afterDelayedResponse,
            pass: true,
          })}`,
        );
        await captureViewport(page, "06-custom-theme-clear-remains-final.png");
      } finally {
        releaseReplacement();
      }
    });
  });

  it("keeps a newer server-applied theme authoritative over a delayed import", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await appearanceGateway(
        page,
        { theme: "claw" },
        "custom-theme-server-race-1",
      );
      const releaseImport = await delayedThemeRoute(page);
      try {
        await openAppearance(page, gateway);
        await themeCard(page, "custom").click();
        const importer = page.locator(".settings-theme-import");
        await importer.locator("input").fill("replacement");
        await importer.locator("button.primary").click();
        const replacementResponse = page.waitForResponse(
          "https://tweakcn.com/r/themes/replacement",
        );
        await expect.poll(() => importer.locator("button.primary").isDisabled()).toBe(true);
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse({ theme: "knot" }, "custom-theme-server-race-2"),
        );
        await gateway.emitGatewayEvent("config.changed", {
          hash: "custom-theme-server-race-2",
          path: "/tmp/openclaw.json",
          ts: Date.now(),
        });
        await waitForRequestCount(gateway, "config.get", configGetCount + 1);
        await expectPressed(themeCard(page, "knot"));

        releaseImport();
        await replacementResponse;
        await expect
          .poll(async () => {
            const settings = await readPersistedSettings(page);
            return {
              hasCustomTheme: typeof settings.customTheme === "object",
              theme: settings.theme,
            };
          })
          .toEqual({ hasCustomTheme: true, theme: "knot" });
        await expectText(importer.locator(".settings-theme-import__message"), "Imported");
        await expect.poll(() => importer.getByRole("status").count()).toBe(1);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      } finally {
        releaseImport();
      }
    });
  });
});
