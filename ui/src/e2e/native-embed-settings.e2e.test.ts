import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { WebSearchStatusResult } from "../../../packages/gateway-protocol/src/schema/web-search.ts";
import type { ChannelsPairingListResult } from "../api/types.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNativeEmbedLayoutMethodResponses,
  installExistingNativeDeviceSettings,
} from "./native-embed-fixtures.test-support.ts";
import { nativeForm } from "./native-form.test-support.ts";
import { installNativeEmbed, installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI native embed settings E2E" });
const phoneOptions = {
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  serviceWorkers: "block",
} as const;
const desktopChrome = ".shell-nav, openclaw-app-topbar, openclaw-macos-titlebar-controls";
const forbiddenEmbeddedUi = [
  desktopChrome,
  ".shell-chrome-controls, .settings-sidebar__footer, openclaw-keyboard-shortcuts-dialog",
  "resizable-divider:visible, .assistant-panel:visible, .debug-overlay:visible",
  "openclaw-assistant-panel-content, openclaw-debug-overlay-content",
].join(", ");
async function visit(page: Page, route: RouteId) {
  const pathname = route === "cron" ? "/cron" : pathForRoute(route);
  expect((await page.goto(new URL(pathname, suite.server.baseUrl).href))?.status()).toBe(200);
  await waitForControlUiRoute(page, { routeId: route });
}
async function back(page: Page, route: RouteId = "settings") {
  await page.locator(".native-embed-header__back").click();
  await waitForControlUiRoute(page, { routeId: route, pathname: pathForRoute(route) });
}
function layoutFits(page: Page) {
  return page.locator("main.content").evaluate((main) => ({
    viewport: document.documentElement.scrollWidth <= window.innerWidth,
    content: main.scrollWidth <= main.clientWidth,
  }));
}
const routes = [
  "custodian",
  "profile",
  "appearance",
  "notifications",
  "device",
  "device-permissions",
  "connection",
  "channels",
  "communications",
  "talk",
  "devices",
  "cloud-workers",
  "agents",
  "model-providers",
  "search",
  "plugin-settings",
  "skill-settings",
  "mcp",
  "memory",
  "automation",
  "security",
  "secrets",
  "approvals",
  "infrastructure",
  "labs",
  "advanced",
  "debug",
  "logs",
  "updates",
  "about",
  "skills",
  "cron",
] as const satisfies readonly RouteId[];
const viewports = [
  { width: 375, height: 812, formFactor: "phone" },
  { width: 390, height: 844, formFactor: "phone" },
  { width: 1024, height: 1366, formFactor: "pad" },
] as const;

suite.define(() => {
  for (const destination of [
    { from: "memory", route: "memory-import", title: "Import Memory", tab: "Settings" },
    { from: "skills", route: "plugins", title: "Plugins", tab: "Plugins" },
    { from: "skills", route: "skill-workshop", title: "Skill workshop", tab: "Skill workshop" },
  ] as const) {
    it(`returns from embedded ${destination.route} through its page link and direct entry`, async () => {
      await suite.withPage(phoneOptions, async ({ page }) => {
        await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
        await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          methodResponses: {
            "migrations.memory.plan": {
              agentId: "main",
              workspace: "/tmp/synthetic-workspace",
              providers: [],
            },
          },
        });
        await visit(page, destination.from);
        await page.getByRole("tab", { name: destination.tab, exact: true }).click();
        if (destination.from === "memory") {
          await page.locator('a[href="/memory-import"]').click();
        }
        await waitForControlUiRoute(page, { routeId: destination.route });
        const header = nativeForm(page.locator(".native-embed-header"));
        await header.heading(destination.title).waitFor();
        expect(await page.locator(".shell-nav, openclaw-app-topbar").count()).toBe(0);
        // Memory's document link uses the parent fallback; hub tabs use app history.
        await back(page, destination.from);

        await visit(page, destination.route);
        await header.heading(destination.title).waitFor();
        const parent = destination.from === "memory" ? "memory" : "settings";
        await back(page, parent);
        if (parent === "memory") {
          await back(page);
        }
      });
    });
  }

  it("keeps embedded Back and settings navigation usable while offline", async () => {
    await suite.withPage(phoneOptions, async ({ page }) => {
      await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read"],
      });
      await visit(page, "talk");
      await page.locator(".native-embed-header__back").waitFor();
      await gateway.setOnline(false);
      await page.locator("openclaw-router-outlet[inert]").waitFor({ state: "attached" });
      await back(page);
      await page
        .locator(".native-embed-header")
        .getByRole("button", { name: /reconnecting.*retry/i })
        .waitFor();
      await page.locator('.settings-embed-list a[href="/settings/appearance"]').click();
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await back(page);
    });
  });

  it("keeps native device capability visibility and overrides native web chrome", async () => {
    await suite.withPage(phoneOptions, async ({ page }) => {
      await installNativeWebChrome(page);
      await installNativeEmbed(page, { platform: "macos", formFactor: "phone" });
      await installExistingNativeDeviceSettings(page);
      await installMockGateway(page, { operatorScopes: ["operator.read"] });
      await visit(page, "settings");
      const list = page.locator(".settings-embed-list");
      const fields = page.locator(
        'input:not([type="hidden"], [type="checkbox"], [type="radio"]), select, textarea',
      );
      await list.locator('a[href="/settings/device"]').waitFor();
      expect(await list.locator('a[href="/settings/security"]').count()).toBe(0);
      for (const route of ["device", "device-permissions", "talk", "updates"] as const) {
        await list.locator(`a[href="${pathForRoute(route)}"]`).click();
        await waitForControlUiRoute(page, { routeId: route });
        expect(await page.locator(desktopChrome).count()).toBe(0);
        expect(await layoutFits(page)).toMatchObject({ content: true });
        expect(
          await fields.evaluateAll((inputs) =>
            inputs
              .filter((field) => field.getBoundingClientRect().width > 0)
              .every((field) => Number.parseFloat(getComputedStyle(field).fontSize) >= 16),
          ),
        ).toBe(true);
        await back(page);
      }
    });
  });
  it("preserves normal desktop chrome without embed flags", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, { operatorScopes: ["operator.admin", "operator.read"] });
        await visit(page, "appearance");
        await page.locator(".shell--settings .settings-sidebar").waitFor();
        expect(await page.locator(".shell-nav").isVisible()).toBe(true);
        expect(await page.locator("openclaw-app-topbar").count()).toBe(1);
        expect(
          await page
            .locator(".shell--embed, .native-embed-header, html.openclaw-native-embed")
            .count(),
        ).toBe(0);
      },
    );
  });
  for (const viewport of viewports) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(`renders settings at ${viewport.width}px in ${colorScheme}`, async () => {
        await suite.withPage(
          { viewport, colorScheme, hasTouch: true, locale: "en-US", serviceWorkers: "block" },
          async ({ page }) => {
            await installNativeEmbed(page, { platform: "ios", formFactor: viewport.formFactor });
            await installExistingNativeDeviceSettings(page);
            const methodResponses = {
              ...createNativeEmbedLayoutMethodResponses(),
              "channels.pairing.list": {
                accounts: [],
                requests: [],
                commandOwnerConfigured: false,
                limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
              } satisfies ChannelsPairingListResult,
              "webSearch.status": {
                enabled: true,
                provider: null,
                agentId: "main",
                model: { provider: "openai", id: "gpt-5.6-luna", runtime: "openclaw" },
                route: {
                  kind: "managed",
                  provider: "parallel-free",
                  label: "Parallel Search (Free)",
                  testable: true,
                },
                providers: [
                  {
                    id: "parallel-free",
                    pluginId: "parallel",
                    label: "Parallel Search (Free)",
                    hint: "Free hosted web search",
                    configured: true,
                    installed: true,
                    available: true,
                    requiresCredential: false,
                    credentialSource: "none",
                    configPath: [],
                  },
                ],
              } satisfies WebSearchStatusResult,
            };
            await installMockGateway(page, {
              methodResponses,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                ...Object.keys(methodResponses),
                "channels.status",
                "secrets.store.set",
                "secrets.store.delete",
              ],
              operatorScopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
              ],
            });
            for (const route of ["settings", ...routes] as const) {
              await visit(page, route);
              await page.locator("html.openclaw-native-embed .shell--embed").waitFor();
              await page
                .locator(".native-embed-header openclaw-settings-save-indicator")
                .waitFor({ state: "attached" });
              expect(await page.locator(forbiddenEmbeddedUi).count()).toBe(0);
              if (route === "settings") {
                const list = page.locator(".settings-embed-list");
                await list.locator("a").first().waitFor();
                expect(
                  await list.locator("a").evaluateAll((links) => ({
                    hrefs: links.map((link) => link.getAttribute("href")),
                    touchTargets: links.every((link) => link.getBoundingClientRect().height >= 44),
                  })),
                ).toEqual({
                  hrefs: routes
                    .filter((id) => id !== "skills" && id !== "cron")
                    .map((id) => pathForRoute(id)),
                  touchTargets: true,
                });
              } else {
                await page.locator(".native-embed-header .page-title").waitFor();
                await page.locator("openclaw-router-outlet").waitFor();
              }
              if (route === "search") {
                await page
                  .getByRole("combobox", { name: "Search provider", exact: true })
                  .waitFor();
                await page.getByRole("button", { name: "Test search", exact: true }).waitFor();
                expect(await page.locator('openclaw-search-page [role="alert"]').count()).toBe(0);
              }
              if (route === "devices") {
                await page.locator(".device-entry__details summary").first().click();
                await page.locator(".device-token-table tbody td").first().waitFor();
              }
              if (["devices", "secrets", "approvals", "debug"].includes(route)) {
                await page
                  .locator(".settings-table--stacked tbody td[data-label]")
                  .first()
                  .waitFor();
                if (viewport.width <= 400) {
                  expect(
                    await page
                      .locator(".settings-table--stacked")
                      .evaluateAll((tables) =>
                        tables.every((table) => table.scrollWidth <= table.clientWidth),
                      ),
                    route,
                  ).toBe(true);
                }
              }
              if (route === "cron") {
                await page.getByText("Healthy automation", { exact: true }).first().waitFor();
              }
              expect(await layoutFits(page), route).toEqual({ viewport: true, content: true });
              if (route !== "settings") {
                await back(page);
                if (route === "appearance") {
                  await page.locator('.settings-embed-list a[href="/settings/appearance"]').click();
                  await waitForControlUiRoute(page, { routeId: "appearance" });
                  await back(page);
                }
              }
            }
          },
        );
      }, 180_000);
    }
  }
});
