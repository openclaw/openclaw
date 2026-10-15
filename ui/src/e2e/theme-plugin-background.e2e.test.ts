import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ThemeDefinition } from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin theme backgrounds" });
const id = "ghost-claw-theme/ghost-claw";
const darkUrl = "/__openclaw__/plugin-theme-art/ghost-claw-theme/ghost-claw/background/dark?v=1";
// 16 × 10 lossless WebP in a single green.
const darkImage = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvD0ACAAfQtXZUp/+BiOh/AAA=", "base64");
const definition: ThemeDefinition = {
  name: "Ghost Claw",
  description: "Slime-black glass with glowing ectoplasm green controls.",
  light: createThemePaletteFixture({ background: "#f4f6f3", foreground: "#0f1a12" }),
  dark: createThemePaletteFixture({ background: "#0a100c", primary: "#5dff6b" }),
};
const theme = {
  id,
  name: definition.name,
  description: definition.description,
  source: "plugin",
  pluginId: "ghost-claw-theme",
  modes: ["light", "dark"],
  artwork: { backgrounds: { dark: { url: darkUrl } } },
};
const catalog = {
  current: { id, mode: "dark", scope: "gateway", overrides: {} },
  theme,
  definition,
  themes: [theme],
};

suite.define(() => {
  it("paints a plugin theme's mode background and keeps neutral artwork for undeclared modes", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const artRequests: string[] = [];
        await page.route("**/__openclaw__/plugin-theme-art/**", (route) => {
          artRequests.push(new URL(route.request().url()).pathname);
          return route.fulfill({ contentType: "image/webp", body: darkImage });
        });
        await page.addInitScript(
          ({ gatewayUrl, id: initialTheme }) =>
            localStorage.setItem(
              "openclaw.control.settings.v1:" + gatewayUrl,
              JSON.stringify({ gatewayUrl, theme: initialTheme, themeMode: "dark" }),
            ),
          { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), id },
        );
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": themeConfigResponse(id, "dark"),
            "themes.list": catalog,
            "themes.get": catalog,
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        const shell = page.locator(".shell");
        const shellImage = () =>
          shell.evaluate((element) => getComputedStyle(element).backgroundImage);
        await expect.poll(shellImage).toMatch(/^linear-gradient\(.+\), url\("blob:/u);
        expect(artRequests).toEqual([darkUrl.split("?")[0]]);
        // Dimmed like a default-strength upload: at least half theme-colored scrim, never opaque.
        const scrim = await page.evaluate(() =>
          Number(
            /(\d+(?:\.\d+)?)%, transparent/u.exec(
              document.documentElement.style.getPropertyValue("--app-background-image"),
            )?.[1],
          ),
        );
        expect(scrim).toBeGreaterThanOrEqual(50);
        expect(scrim).toBeLessThan(100);
        expect(await page.locator("html").getAttribute("data-theme")).toBe("custom");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.waitForTimeout(500);
          writeFileSync(
            path.join(suite.artifactDir, "after-dark-new.png"),
            await page.screenshot({ animations: "disabled" }),
          );
        }

        await gateway.setMethodResponse("config.get", themeConfigResponse(id, "light"));
        await gateway.emitGatewayEvent("config.changed", {});
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme"))
          .toBe("custom-light");
        await expect.poll(shellImage).toMatch(/custom-light[^/]*\.webp/u);
        expect(
          await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--app-background-image"),
          ),
        ).toBe("");
        expect(artRequests).toHaveLength(1);
      },
    );
  });
});
