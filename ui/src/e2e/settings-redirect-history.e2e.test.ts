import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../api/types.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings redirect history diagnostic" });

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

suite.define(() => {
  it.each(cases)("preserves Back and Forward through $name", async (scenario) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 1000 } },
      },
      async ({ page }) => {
        const linkLabel = `Open saved Settings link: ${scenario.name}`;
        await installMockGateway(page, {
          methodResponses: {
            "channels.status": {
              ts: 1_789_516_800_000,
              channelOrder: [],
              channelLabels: {},
              channelMeta: [],
              channels: {},
              channelAccounts: {},
              channelDefaultAccountId: {},
            } satisfies ChannelsStatusSnapshot,
            "channels.pairing.list": {
              accounts: [],
              requests: [],
              commandOwnerConfigured: true,
              limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
            } satisfies ChannelsPairingListResult,
          },
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `[${linkLabel}](${scenario.source})` }],
              timestamp: 1_789_516_800_000,
            },
          ],
        });
        const events: { event: string; url: string }[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            events.push({ event: "navigation", url: relativeUrl(page) });
          }
        });
        const report: Record<string, unknown> = { scenario, events };
        const capture = async (stage: string) => {
          report[stage] = {
            url: relativeUrl(page),
            historyLength: await page.evaluate(() => window.history.length),
            savedLinkVisible: await page
              .getByRole("link", { name: linkLabel, exact: true })
              .isVisible(),
            destinationVisible: await page.locator(scenario.surface).isVisible(),
          };
          await writeFile(
            path.join(suite.artifactDir, `${stage}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), []),
          );
        };
        try {
          await page.goto(`${suite.server.baseUrl}chat/main`);
          const link = page.getByRole("link", { name: linkLabel, exact: true });
          await link.waitFor();
          expect(await link.getAttribute("href")).toBe(scenario.source);
          expect(await link.getAttribute("target")).toBeNull();
          const startUrl = relativeUrl(page);
          report.startUrl = startUrl;
          report.bundleScripts = await page
            .locator('script[type="module"][src]')
            .evaluateAll((scripts) => scripts.map((script) => script.getAttribute("src")));
          expect(report.bundleScripts).toEqual(
            expect.arrayContaining([expect.stringMatching(/\/assets\//u)]),
          );
          await capture("01-start");

          await link.click();
          await expect.poll(() => relativeUrl(page)).toBe(scenario.destination);
          const destination = page.locator(scenario.surface);
          await destination.waitFor();
          await destination.getByText(scenario.title, { exact: true }).first().waitFor();
          await capture("02-redirected");

          await page.goBack({ waitUntil: "domcontentloaded" });
          try {
            await expect.poll(() => relativeUrl(page)).toBe(startUrl);
            await page.getByRole("link", { name: linkLabel, exact: true }).waitFor();
          } catch (error) {
            report.backAssertion = String(error);
          }
          await capture("03-after-back");
          const afterBack = relativeUrl(page);

          const forward = await page.goForward({ waitUntil: "domcontentloaded" });
          report.forwardDocumentResponse = forward?.status() ?? null;
          await expect.poll(() => relativeUrl(page)).toBe(scenario.destination);
          await page.locator(scenario.surface).waitFor();
          await capture("04-after-forward");

          expect(afterBack, "Back must leave the canonical Settings destination").toBe(startUrl);
          expect(report.backAssertion).toBeUndefined();
        } finally {
          await writeFile(
            path.join(suite.artifactDir, "history-report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
          );
        }
      },
    );
  });
});
