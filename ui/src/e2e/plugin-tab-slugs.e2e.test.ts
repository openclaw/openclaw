import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PluginPageElement } from "../pages/plugin/plugin-page.tsx";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

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

async function expectReports(page: Page) {
  await page
    .frameLocator("openclaw-plugin-page iframe")
    .getByRole("heading", { name: "Synthetic reports" })
    .waitFor();
  expect(new URL(page.url()).pathname).toBe("/reports");
  expect(
    await page
      .locator("openclaw-plugin-page")
      .evaluate(({ pluginId: plugin, tabId: tab }: PluginPageElement) => ({
        pluginId: plugin,
        id: tab,
      })),
  ).toEqual({ pluginId, id: tabId });
  await openSidebarPages(page);
  const sidebarEntry = page.locator(
    `.sidebar-pages [data-sidebar-entry="plugin:${pluginId}/${tabId}"] a`,
  );
  expect(await sidebarEntry.getAttribute("href")).toBe("/reports");
  expect(await sidebarEntry.getAttribute("aria-current")).toBe("page");
  expect(await sidebarEntry.isVisible()).toBe(true);
}

async function openReports(page: Page) {
  const pages = await openSidebarPages(page);
  const entry = pages.getByRole("link", { name: "Reports", exact: true });
  await entry.waitFor();
  expect(await entry.getAttribute("href")).toBe("/reports");
  await entry.click();
}

suite.define(() => {
  it("opens the advertised slug from the sidebar inside the plugin page shell", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installReports(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await openReports(page);
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
      expect(new URL(page.url())).toMatchObject({ search: "?p.range=week", hash: "#details" });
      expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
    });
  });

  it("forwards an explicit host theme and live switches without reloading the plugin frame", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "light" },
      async ({ page }) => {
        const { frameRequests } = await installReports(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await expect
          .poll(() =>
            evaluateControlUiContext(page, (context) => context.config.current.embedSandboxMode),
          )
          .toBe("scripts");
        await openReports(page);
        // The first frame must receive the script policy without a corrective reload.
        const sandbox = await page.locator("openclaw-plugin-page iframe").getAttribute("sandbox");
        expect(sandbox?.split(/\s+/u)).toContain("allow-scripts");
        const frame = page.frameLocator("openclaw-plugin-page iframe");
        const receivedTheme = frame.getByLabel("Received OpenClaw theme");
        const readTheme = async (after?: number) => {
          const received = JSON.parse((await receivedTheme.textContent()) ?? "{}");
          return {
            ...received,
            advanced: after === undefined || Number(received.messages) > after,
          };
        };
        const expectTheme = async (mode: "dark" | "light", after?: number) => {
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
          await expect
            .poll(() => readTheme(after))
            .toMatchObject({
              instance: "1",
              mode,
              messages: expect.any(Number),
              surface: expect.stringMatching(/\S/),
              advanced: true,
            });
        };
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(
          true,
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        const modeItem = (mode: string) =>
          sidebar.getByRole("menuitem", { name: `Color mode: ${mode}`, exact: true });
        const identityMenu = sidebar.getByRole("button", { name: /^Identity and app menu for / });
        await identityMenu.click();
        for (const currentMode of ["System", "Light"] as const) {
          await modeItem(currentMode).click();
          await modeItem(currentMode === "System" ? "Light" : "Dark").waitFor();
        }
        await expectTheme("dark");
        const initialMessageCount = Number((await readTheme()).messages);

        await modeItem("Dark").click();

        await expectTheme("light", initialMessageCount);
        expect(frameRequests).toHaveLength(1);
      },
    );
  });
});
