// Control UI tests prove locale chunk recovery through a real browser reconnect.
import type { BrowserContext, Page, Route } from "playwright";
import { expect, it } from "vitest";
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
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const frenchLocaleModule = /\/src\/i18n\/locales\/fr\.ts(?:\?.*)?$/;

async function createContext(): Promise<BrowserContext> {
  return suite.newBrowserContext(createControlUiE2eContextOptions());
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
  it("loads a selected locale on demand and updates the mounted Appearance heading", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page);
    let localeRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/src/i18n/locales/zh-CN.ts") {
        localeRequests += 1;
      }
    });

    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const heading = page.locator("openclaw-config-page h1.page-title");
    const picker = page.locator("#settings-language openclaw-select-picker");
    await expect.poll(() => heading.textContent()).toBe("Appearance");

    expect(localeRequests).toBe(0);
    await selectPickerValue(picker, "zh-CN");
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
    await expect.poll(() => heading.textContent()).toBe("外观");
    expect(localeRequests).toBe(1);

    await selectPickerValue(picker, "ca");
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("ca");
    expect(await picker.locator(".picker-select__trigger").textContent()).toContain("Català");

    await selectPickerValue(picker, "en");
    await expect.poll(() => heading.textContent()).toBe("Appearance");
    expect(new URL(page.url()).pathname).toBe("/settings/appearance");
  });

  it("labels the browser-selected language in the system picker", async () => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: "sv-FI",
    });
    const page = await context.newPage();
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const picker = page.locator("#settings-language openclaw-select-picker");
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("sv");
    await picker.locator(".picker-select__trigger").click();
    for (const value of ["sv", "system"]) {
      expect(
        await picker.locator(`[role="option"][data-value="${value}"]`).textContent(),
      ).toContain("Svenska");
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
    }
  });
});
