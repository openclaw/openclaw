import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings redirect history" });

const cases = [
  {
    name: "removed General control",
    source: "/settings/general#settings-general-language",
    destination: "/settings/appearance?section=__appearance__#settings-language",
    surface: "openclaw-config-page",
    title: "Appearance",
  },
  {
    name: "moved Channels section",
    source: "/settings/communications?section=channels",
    destination: "/settings/channels",
    surface: "openclaw-channels-page",
    title: "Channels",
  },
] as const;

function relativeUrl(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
}

suite.define(() =>
  it.each(cases)("preserves Back and Forward through $name", (scenario) =>
    suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        const linkLabel = `Open saved Settings link: ${scenario.name}`;
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `[${linkLabel}](${scenario.source})` }],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const link = page.getByRole("link", { name: linkLabel, exact: true });
        await link.waitFor();
        expect(await link.getAttribute("href")).toBe(scenario.source);
        expect(await link.getAttribute("target")).toBeNull();
        const startUrl = relativeUrl(page);
        const bundleScripts = await page
          .locator('script[type="module"][src]')
          .evaluateAll((scripts) => scripts.map((script) => script.getAttribute("src")));
        expect(bundleScripts).toEqual(
          expect.arrayContaining([expect.stringMatching(/\/assets\//u)]),
        );

        await link.click();
        await expect.poll(() => relativeUrl(page)).toBe(scenario.destination);
        const destination = page.locator(scenario.surface);
        await destination.waitFor();
        await destination.getByText(scenario.title, { exact: true }).first().waitFor();

        await page.goBack({ waitUntil: "domcontentloaded" });
        await expect.poll(() => relativeUrl(page)).toBe(startUrl);
        await page.getByRole("link", { name: linkLabel, exact: true }).waitFor();

        await page.goForward({ waitUntil: "domcontentloaded" });
        await expect.poll(() => relativeUrl(page)).toBe(scenario.destination);
        await page.locator(scenario.surface).waitFor();
      },
    ),
  ),
);
