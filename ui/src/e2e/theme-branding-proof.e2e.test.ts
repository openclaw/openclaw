import { expect, it } from "vitest";
import type { ThemeDefinition } from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Theme branding proof" });
const pageOptions = {
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  colorScheme: "light",
  serviceWorkers: "block",
} as const;
const id = "northstar/workspace";
const artUrl = "/__openclaw__/plugin-theme-art/northstar/workspace/icon/compass?v=1";
const artwork = { icons: { compass: { url: artUrl } } };
const definition: ThemeDefinition = {
  name: "Northstar",
  description: "Synthetic Northstar branding fixture",
  brandName: "Northstar",
  mascot: "none",
  brandIcon: "compass",
  workingIndicator: "brand",
  workingPhrases: [],
  lobsterdex: false,
  communityLinks: false,
  light: createThemePaletteFixture(),
  dark: createThemePaletteFixture(),
};
function catalog(value: ThemeDefinition) {
  const theme = {
    id,
    ...value,
    source: "plugin",
    pluginId: "northstar",
    modes: ["light", "dark"],
    artwork,
  };
  return {
    current: { id, mode: "light", scope: "gateway", overrides: {} },
    theme,
    definition: value,
    themes: [theme],
  };
}
async function setTheme(gateway: MockGatewayControls, value: ThemeDefinition, generation?: number) {
  for (const method of ["themes.list", "themes.get"]) {
    await gateway.setMethodResponse(method, catalog(value));
  }
  if (generation !== undefined) {
    await gateway.emitGatewayEvent("plugins.changed", { generation });
  }
}
suite.define(() => {
  it("applies plugin branding, hides collection entry points, and hot reloads without losing preferences", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.route("**/__openclaw__/plugin-theme-art/**", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#207d82"/><path d="M50 12 60 40 88 50 60 60 50 88 40 60 12 50 40 40Z" fill="#ffffff"/></svg>',
        }),
      );
      const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
      const settingsKey = `openclaw.control.settings.v1:${gatewayUrl}`;
      const settings = { gatewayUrl, theme: id, themeMode: "light", tabIcon: "lobster:crimson" };
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
        key: settingsKey,
        value: JSON.stringify(settings),
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": themeConfigResponse(id, "light"),
          "themes.list": catalog(definition),
          "themes.get": catalog(definition),
        },
      });
      await page.goto(suite.server.baseUrl + "settings/about");
      const name = page.locator(".about-hero__name");
      await expect.poll(() => name.textContent()).toBe("Northstar");
      const hero = page.locator(".about-hero");
      await hero.locator("openclaw-theme-brand-icon img").waitFor();
      expect(await hero.locator(".about-hero__clawd, a").count()).toBe(0);
      expect(await page.title()).toBe("About — Northstar");
      await page.getByRole("link", { name: "Ask Northstar", exact: true }).waitFor();
      await page.goto(suite.server.baseUrl + "settings/appearance");
      const tabIcon = page.locator(".settings-tab-icon");
      await tabIcon.waitFor();
      await expect.poll(() => page.locator(".lobsterdex__gallery").count()).toBe(0);
      expect(await page.getByText("Lobster visits", { exact: true }).count()).toBe(0);
      expect(await tabIcon.getByText("Lobsterdex", { exact: true }).count()).toBe(0);
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").tabIcon,
          settingsKey,
        ),
      ).toBe("lobster:crimson");
      await page.goto(suite.server.baseUrl + "settings/lobsterdex");
      await page.locator("openclaw-lobsterdex-page section[role=status]").waitFor();
      expect(await page.locator(".lobsterdex-page__card").count()).toBe(0);
      const restored = { ...definition, brandName: "Northstar Lab", lobsterdex: true };
      await setTheme(gateway, restored, 2);
      await page.locator(".lobsterdex-page__card").first().waitFor();
      await page.goto(suite.server.baseUrl + "settings/about");
      await expect.poll(() => name.textContent()).toBe("Northstar Lab");
      await setTheme(gateway, {
        ...definition,
        brandName: "OpenClaw",
        brandIcon: "claw",
        mascot: "claw",
        workingIndicator: "claw",
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Explore the new workspace.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await gateway.waitForRequest("chat.send");
      const indicator = page.locator(".chat-reading-indicator");
      await indicator.locator("svg").waitFor();
      await setTheme(gateway, definition, 3);
      const workingImage = indicator.locator("openclaw-theme-brand-icon img");
      await workingImage.waitFor();
      const bounds = await workingImage.boundingBox();
      expect(bounds?.width).toBeGreaterThan(0);
      expect(bounds?.height).toBeGreaterThan(0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await indicator.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        "none",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await indicator.getAttribute("class")).toContain("chat-reading-indicator--brand");
      await setTheme(gateway, { ...definition, workingIndicator: "none" }, 4);
      await expect.poll(() => indicator.count()).toBe(0);
      await page
        .locator(".chat-working-indicator__status")
        .getByText("Working…", { exact: true })
        .waitFor();
    });
  });
});
