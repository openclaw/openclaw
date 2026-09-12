import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PluginPage } from "../pages/plugin/plugin-page.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI plugin tab slugs" });
const pluginId = "reports-fixture";
const tabId = "summary";

async function installReports(page: Page, holdHello = false) {
  await page.route("**/plugins/reports-fixture/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1>Synthetic reports</h1>",
    }),
  );
  return installMockGateway(page, {
    controlUiTabs: [
      { pluginId, id: tabId, label: "Reports", slug: "reports", path: "/plugins/reports-fixture/" },
    ],
    heldMethods: holdHello ? ["connect"] : [],
  });
}

async function expectReports(page: Page, pathname = "/reports") {
  await page
    .frameLocator("openclaw-plugin-page iframe")
    .getByRole("heading", {
      name: "Synthetic reports",
    })
    .waitFor();
  expect(new URL(page.url()).pathname).toBe(pathname);
  expect(
    await page.locator("openclaw-plugin-page").evaluate((element: PluginPage) => ({
      pluginId: element.pluginId,
      id: element.tabId,
    })),
  ).toEqual({ pluginId, id: tabId });
  const sidebarEntry = page.locator(`[data-sidebar-entry="plugin:${pluginId}/${tabId}"] a`);
  expect(await sidebarEntry.getAttribute("href")).toBe("/reports");
  expect(await sidebarEntry.getAttribute("aria-current")).toBe("page");
  expect(await sidebarEntry.isVisible()).toBe(true);
}

suite.define(() => {
  it("opens the advertised slug from the sidebar inside the plugin page shell", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installReports(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const entry = page.getByRole("link", { name: "Reports", exact: true });
      await entry.waitFor();
      expect(await entry.getAttribute("href")).toBe("/reports");
      await entry.click();
      await expectReports(page);
    });
  });

  it.each(["reports", "reports/"])(
    "keeps a cold %s deep link until hello resolves the tab",
    async (path) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installReports(page, true);
        const paths: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            paths.push(new URL(frame.url()).pathname);
          }
        });
        await page.goto(`${suite.server.baseUrl}${path}`);
        await gateway.waitForRequest("connect");
        expect(new URL(page.url()).pathname).toBe(`/${path}`);
        expect(await page.locator("openclaw-plugin-page").count()).toBe(0);
        await gateway.resolveDeferred("connect");
        await expectReports(page, `/${path}`);
        expect(paths).not.toContain("/chat");
      });
    },
  );

  it("recovers an unknown slug to chat only after hello", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installReports(page, true);
      await page.goto(`${suite.server.baseUrl}unknown-reports`);
      await gateway.waitForRequest("connect");
      expect(new URL(page.url()).pathname).toBe("/unknown-reports");
      await gateway.resolveDeferred("connect");
      await page.waitForURL((url) => /^\/chat(?:\/|$)/.test(url.pathname));
      expect(await page.locator("openclaw-plugin-page").count()).toBe(0);
    });
  });

  it("replaces the generic tab URL with its slug while preserving page parameters and hash", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installReports(page, true);
      await page.goto(
        `${suite.server.baseUrl}plugin?plugin=${pluginId}&id=${tabId}&p.range=week#details`,
      );
      await gateway.waitForRequest("connect");
      const historyLength = await page.evaluate(() => window.history.length);
      await gateway.resolveDeferred("connect");
      await expectReports(page);
      const location = new URL(page.url());
      expect(location.search).toBe("?p.range=week");
      expect(location.hash).toBe("#details");
      expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
    });
  });
});
