// Control UI tests prove locale chunk recovery through a real browser reconnect.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page, Route } from "playwright";
import { expect, it } from "vitest";
import { isSupportedLocale, SUPPORTED_LOCALES } from "../i18n/lib/registry.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI offline locale retry",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const frenchLocaleModule = /\/src\/i18n\/locales\/fr\.ts(?:\?.*)?$/;

async function createContext(): Promise<BrowserContext> {
  return suite.browser.newContext(createControlUiE2eContextOptions());
}

async function gatewayPhase(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase ?? undefined);
}

async function documentMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => (window as Window & { localeRetryDocumentMarker?: string }).localeRetryDocumentMarker,
  );
}

async function reconnect(page: Page, gateway: MockGatewayControls): Promise<void> {
  const socketCountBefore = await gateway.getSocketCount();
  await gateway.closeLatest(1001, "proxy idle timeout");
  await gateway.setOnline(false);
  await expect.poll(() => gatewayPhase(page)).toBe("reconnecting");
  await expect
    .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
    .toBeGreaterThan(socketCountBefore);
  await gateway.setOnline(true);
  await expect.poll(() => gatewayPhase(page)).toBe("connected");
}

suite.define(() => {
  it.each([
    { name: "sv-SE", browserLocale: "sv-SE", savedLocale: null, expectedLocale: "sv" },
    { name: "sv-FI", browserLocale: "sv-FI", savedLocale: null, expectedLocale: "sv" },
    { name: "saved-sv", browserLocale: "en-US", savedLocale: "sv", expectedLocale: "sv" },
    { name: "saved-fr", browserLocale: "sv-SE", savedLocale: "fr", expectedLocale: "fr" },
  ])("preserves the browser or saved language for $name after reload", async (scenario) => {
    const context = await suite.browser.newContext({
      ...createControlUiE2eContextOptions(),
      locale: scenario.browserLocale,
    });
    const page = await context.newPage();
    if (scenario.savedLocale) {
      await page.addInitScript((savedLocale) => {
        if (!sessionStorage.getItem("swedish-locale-test.initialized")) {
          localStorage.setItem("openclaw.i18n.locale", savedLocale);
          sessionStorage.setItem("swedish-locale-test.initialized", "1");
        }
      }, scenario.savedLocale);
    }
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const picker = page.locator("#settings-language openclaw-select-picker");
      await picker.waitFor();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.lang))
        .toBe(scenario.expectedLocale);
      const trigger = picker.locator(".picker-select__trigger");
      await trigger.click();
      const swedishOption = picker.locator('[role="option"][data-value="sv"]');
      await swedishOption.waitFor();
      await swedishOption.scrollIntoViewIfNeeded();
      expect(await swedishOption.textContent()).toContain("Svenska");
      if (!scenario.savedLocale) {
        expect(
          await picker.locator('[role="option"][data-value="system"]').textContent(),
        ).toContain("Svenska");
      }
      const artifacts = createControlUiE2eArtifactDir("swedish-locale");
      await page.screenshot({
        path: path.join(artifacts, `${scenario.name}-picker-before-reload.png`),
      });

      await page.reload();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.lang))
        .toBe(scenario.expectedLocale);
      const browserState = {
        ...(await page.evaluate(() => ({
          navigatorLanguage: navigator.language,
          documentLanguage: document.documentElement.lang,
          savedLocale: localStorage.getItem("openclaw.i18n.locale"),
        }))),
        swedishTranslationMemoryPresent: existsSync(
          new URL("../i18n/.i18n/sv.tm.jsonl", import.meta.url),
        ),
      };
      expect(browserState.navigatorLanguage).toBe(scenario.browserLocale);
      expect(browserState.savedLocale).toBe(scenario.savedLocale);
      await trigger.click();
      await swedishOption.waitFor();
      await swedishOption.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(artifacts, `${scenario.name}-picker-after-reload.png`),
      });
      writeFileSync(
        path.join(artifacts, `${scenario.name}-browser-state.json`),
        `${JSON.stringify(browserState, null, 2)}\n`,
      );
    } finally {
      await context.close();
    }
  });

  it("lazy-loads each registered locale only after the operator selects it", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page);
    const requests = new Map<string, number>();
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(/\/src\/i18n\/locales\/([^/]+)\.ts$/);
      // English registrar modules are not operator-selectable locale adapters.
      if (match?.[1] && isSupportedLocale(match[1]) && match[1] !== "en") {
        requests.set(match[1], (requests.get(match[1]) ?? 0) + 1);
      }
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const picker = page.locator("#settings-language openclaw-select-picker");
      await picker.waitFor();
      expect(requests.size).toBe(0);

      for (const locale of SUPPORTED_LOCALES.slice(1)) {
        await selectPickerValue(picker, locale);
        await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale);
        expect(requests.get(locale)).toBe(1);
      }
      expect(requests.size).toBe(SUPPORTED_LOCALES.length - 1);
    } finally {
      await context.close();
    }
  });

  it("applies a locale whose first chunk request failed after the Gateway reconnects", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      webSocketPassthroughPrefixes: [`${controlUiBundledGatewayUrl(suite.server.baseUrl)}/?token=`],
    });
    let abortedLocaleRequests = 0;
    const abortFrenchLocale = async (route: Route) => {
      abortedLocaleRequests += 1;
      await route.abort("internetdisconnected");
    };
    await page.route(frenchLocaleModule, abortFrenchLocale);
    let documentRequestCount = 0;

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          documentRequestCount += 1;
        }
      });
      await page.locator(".settings-row__title", { hasText: "Language" }).waitFor();
      await page.evaluate(() => {
        (window as Window & { localeRetryDocumentMarker?: string }).localeRetryDocumentMarker =
          "same-document";
      });

      const languageSelect = page.locator("#settings-language openclaw-select-picker");
      await selectPickerValue(languageSelect, "fr");

      await expect.poll(() => abortedLocaleRequests).toBe(1);
      await page.locator(".settings-row__title", { hasText: "Language" }).waitFor();
      await page.locator(".settings-page").waitFor();
      expect(await documentMarker(page)).toBe("same-document");
      expect(documentRequestCount).toBe(0);

      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await reconnect(page, gateway);

      await page
        .locator(".settings-row__title", { hasText: "Langue" })
        .waitFor({ timeout: 10_000 });
      expect(await documentMarker(page)).toBe("same-document");
      expect(documentRequestCount).toBe(0);
      expect(await page.evaluate(() => document.documentElement.lang)).toBe("fr");
      expect(new URL(page.url()).pathname).toBe("/settings/appearance");
    } finally {
      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await context.close();
    }
  });
});
