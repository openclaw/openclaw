import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ThemeDefinition } from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Theme branding proof" });
const id = "northstar/workspace";
const artUrl = "/__openclaw__/plugin-theme-art/northstar/workspace/icon/compass?v=1";
const artwork = { icons: { compass: { url: artUrl } } };
const definition: ThemeDefinition = {
  name: "Northstar",
  description: "A quiet, unbranded workspace",
  brandName: "Northstar",
  mascot: "none",
  brandIcon: "compass",
  workingIndicator: "brand",
  workingPhrases: [],
  lobsterdex: false,
  communityLinks: false,
  light: createThemePaletteFixture({
    background: "#f3f2eb",
    foreground: "#172226",
    card: "#ffffff",
    "card-foreground": "#172226",
    popover: "#ffffff",
    "popover-foreground": "#172226",
    primary: "#207d82",
    "primary-foreground": "#ffffff",
    secondary: "#e8e9e3",
    "secondary-foreground": "#172226",
    muted: "#e8e9e3",
    "muted-foreground": "#646e70",
    accent: "#207d82",
    "accent-foreground": "#ffffff",
    border: "#ddddda",
    input: "#ddddda",
    ring: "#207d82",
    "font-sans": "Instrument Sans, sans-serif",
  }),
  dark: createThemePaletteFixture({
    primary: "#6fe0d2",
    accent: "#6fe0d2",
    "font-sans": "Instrument Sans, sans-serif",
  }),
};
function catalog(value: ThemeDefinition) {
  const theme = {
    id,
    ...value,
    definition: undefined,
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
suite.define(() => {
  it("applies plugin branding, hides collection entry points, and hot reloads without losing preferences", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.route("**/__openclaw__/plugin-theme-art/**", (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#207d82"/><path d="M50 12 60 40 88 50 60 60 50 88 40 60 12 50 40 40Z" fill="#ffffff"/></svg>',
          }),
        );
        await page.addInitScript(
          ({ gatewayUrl, id: initialTheme }) =>
            localStorage.setItem(
              "openclaw.control.settings.v1:" + gatewayUrl,
              JSON.stringify({
                gatewayUrl,
                theme: initialTheme,
                themeMode: "light",
                tabIcon: "lobster:crimson",
              }),
            ),
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), id },
        );
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
        expect(await hero.locator(".about-hero__clawd").count()).toBe(0);
        expect(await hero.locator("a").count()).toBe(0);
        expect(await page.title()).toBe("About — Northstar");
        await page.getByRole("link", { name: "Ask Northstar", exact: true }).waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            [hero],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "after-about.png"), frame.png);
        }
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await page.locator(".settings-tab-icon").waitFor();
        await expect.poll(() => page.locator(".lobsterdex__gallery").count()).toBe(0);
        expect(await page.getByText("Lobster visits", { exact: true }).count()).toBe(0);
        expect(
          await page.locator(".settings-tab-icon").getByText("Lobsterdex", { exact: true }).count(),
        ).toBe(0);
        expect(
          await page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem(
                  "openclaw.control.settings.v1:" + location.origin.replace(/^http/, "ws"),
                ) ?? "{}",
              ).tabIcon,
          ),
        ).toBe("lobster:crimson");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const tabIcon = page.locator(".settings-tab-icon");
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            [tabIcon],
            { animations: "disabled", scrollTo: tabIcon },
          );
          writeFileSync(path.join(suite.artifactDir, "after-appearance.png"), frame.png);
        }
        await page.goto(suite.server.baseUrl + "settings/lobsterdex");
        await page.locator("openclaw-lobsterdex-page section[role=status]").waitFor();
        expect(await page.locator(".lobsterdex-page__card").count()).toBe(0);
        const restored = { ...definition, brandName: "Northstar Lab", lobsterdex: true };
        await gateway.setMethodResponse("themes.list", catalog(restored));
        await gateway.setMethodResponse("themes.get", catalog(restored));
        await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
        await page.locator(".lobsterdex-page__card").first().waitFor();
        await page.goto(suite.server.baseUrl + "settings/about");
        await expect.poll(() => name.textContent()).toBe("Northstar Lab");
        const claw = {
          ...definition,
          brandName: "OpenClaw",
          brandIcon: "claw",
          mascot: "claw" as const,
          workingIndicator: "claw" as const,
        };
        await gateway.setMethodResponse("themes.list", catalog(claw));
        await gateway.setMethodResponse("themes.get", catalog(claw));
        await page.goto(suite.server.baseUrl + "chat");
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Explore the new workspace.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await gateway.waitForRequest("chat.send");
        const indicator = page.locator(".chat-reading-indicator");
        await indicator.locator("svg").waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            [indicator],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "before-working.png"), frame.png);
        }
        await gateway.setMethodResponse("themes.list", catalog(definition));
        await gateway.setMethodResponse("themes.get", catalog(definition));
        await gateway.emitGatewayEvent("plugins.changed", { generation: 3 });
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
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            [indicator],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "after-working.png"), frame.png);
        }
        await gateway.setMethodResponse(
          "themes.list",
          catalog({ ...definition, workingIndicator: "none" }),
        );
        await gateway.setMethodResponse(
          "themes.get",
          catalog({ ...definition, workingIndicator: "none" }),
        );
        await gateway.emitGatewayEvent("plugins.changed", { generation: 4 });
        await expect.poll(() => indicator.count()).toBe(0);
        await page
          .locator(".chat-working-indicator__status")
          .getByText("Working…", { exact: true })
          .waitFor();
      },
    );
  });
});
