import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PluginPage } from "../pages/plugin/plugin-page.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI plugin tab slugs" });
const pluginId = "reports-fixture";
const tabId = "summary";

async function installReports(page: Page, holdHello = false) {
  const frameRequests: string[] = [];
  await page.route("**/plugins/reports-fixture/", (route) => {
    frameRequests.push(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
          <html data-instance="${frameRequests.length}">
            <body>
              <h1>Synthetic reports</h1>
              <output aria-label="Received OpenClaw theme"></output>
              <script>
                let themeMessages = 0;
                addEventListener("message", (event) => {
                  if (event.data?.type !== "openclaw:widget-theme") return;
                  themeMessages += 1;
                  document.querySelector("output").textContent = JSON.stringify({
                    instance: document.documentElement.dataset.instance,
                    messages: themeMessages,
                    mode: event.data.mode,
                    surface: event.data.tokens.surface,
                  });
                });
              </script>
            </body>
          </html>`,
    });
  });
  const gateway = await installMockGateway(page, {
    controlUiTabs: [
      { pluginId, id: tabId, label: "Reports", slug: "reports", path: "/plugins/reports-fixture/" },
    ],
    heldMethods: holdHello ? ["connect"] : [],
  });
  return { gateway, frameRequests };
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
    "keeps a cold %s deep link over the remembered session until hello resolves the tab",
    async (path) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const { gateway } = await installReports(page, true);
        await page.addInitScript((settingsKey) => {
          localStorage.setItem(settingsKey, JSON.stringify({ sessionKey: "agent:main:main" }));
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
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
        await expectReports(page);
        expect(paths).not.toContain("/chat");
        await page.reload();
        await gateway.waitForRequest("connect");
        expect(new URL(page.url()).pathname).toBe("/reports");
        await gateway.resolveDeferred("connect");
        await expectReports(page);
      });
    },
  );

  it("recovers an unknown slug to chat only after hello", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway } = await installReports(page, true);
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
      const { gateway } = await installReports(page, true);
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

  it("forwards an explicit host theme and live switches without reloading the plugin frame", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "light" },
      async ({ page }) => {
        const { frameRequests } = await installReports(page);
        await page.goto(`${suite.server.baseUrl}reports`);
        const frame = page.frameLocator("openclaw-plugin-page iframe");
        const receivedTheme = frame.getByLabel("Received OpenClaw theme");
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(
          true,
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        const identityMenu = sidebar.getByRole("button", { name: /^Identity and app menu for / });
        if (!(await sidebar.locator(".theme-mode-toggle").isVisible())) {
          await identityMenu.click();
        }
        for (const currentMode of ["System", "Light"] as const) {
          const toggle = sidebar.getByRole("button", { name: `Color mode: ${currentMode}` });
          if (await toggle.isVisible()) {
            await toggle.click();
          }
        }
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        await expect
          .poll(async () => JSON.parse((await receivedTheme.textContent()) ?? "{}"))
          .toMatchObject({
            instance: "1",
            messages: expect.any(Number),
            mode: "dark",
            surface: expect.stringMatching(/\S/),
          });
        const initialMessageCount = Number(
          JSON.parse((await receivedTheme.textContent()) ?? "{}").messages,
        );

        const toggle = sidebar.getByRole("button", { name: "Color mode: Dark" });
        if (!(await toggle.isVisible())) {
          await identityMenu.click();
        }
        await toggle.click();

        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        await expect
          .poll(async () => {
            const received = JSON.parse((await receivedTheme.textContent()) ?? "{}");
            return {
              instance: received.instance,
              mode: received.mode,
              receivedLiveUpdate: Number(received.messages) > initialMessageCount,
              surface: received.surface,
            };
          })
          .toEqual({
            instance: "1",
            mode: "light",
            receivedLiveUpdate: true,
            surface: expect.stringMatching(/\S/),
          });
        expect(frameRequests).toHaveLength(1);
      },
    );
  });
});
