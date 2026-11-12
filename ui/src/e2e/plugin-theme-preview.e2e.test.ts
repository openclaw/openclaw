import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  BUILTIN_THEMES,
  type ThemeCatalogEntry,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import {
  calendarInspection,
  calendarPlugin,
  inventory,
  pluginMethodResponses,
  pluginMethods,
} from "../pages/plugins/plugins.e2e.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createPluginDeclaredSurface } from "../test-helpers/plugins-e2e-fixtures.test-support.ts";
import { requireRecord } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Installed theme previews",
  trackBrowserContexts: true,
});
// Public Artemis Canopy 1.0.2 palette, source commit 758c79f167fad4a02cb84049c7fa7a65637dbb02.
const definition = {
  name: "Artemis Canopy",
  description:
    "Carbon-black panels, sage-green signals, and restrained gold inspired by Artemis Lost\u2019s Canopy Dark mission console.",
  dark: {
    background: "#061009",
    foreground: "#e1f1e5",
    card: "#0a1710",
    "card-foreground": "#f4fff6",
    popover: "#09130d",
    "popover-foreground": "#f4fff6",
    primary: "#e6c178",
    "primary-foreground": "#171207",
    secondary: "#16281d",
    "secondary-foreground": "#e6c178",
    muted: "#0c1810",
    "muted-foreground": "#afc9b8",
    accent: "#243e2c",
    "accent-foreground": "#f0d79d",
    destructive: "#e07b66",
    "destructive-foreground": "#160907",
    border: "#35523e",
    input: "#1d3426",
    ring: "#d1af63",
    "font-sans": '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    "font-mono": '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  },
};
const artemis: ThemeCatalogEntry = {
  id: "artemis-canopy-theme/canopy-dark",
  name: definition.name,
  description: definition.description,
  source: "plugin",
  pluginId: "artemis-canopy-theme",
  modes: ["dark"],
  definition,
};
const pack: ThemeCatalogEntry[] = ["forest", "sunrise"].map<ThemeCatalogEntry>((id) =>
  Object.assign({}, artemis, {
    id: `landscapes/${id}`,
    pluginId: "landscapes",
    name: id === "forest" ? "Forest" : "Sunrise",
    modes: id === "forest" ? ["dark"] : ["light", "dark"],
    definition: {
      ...definition,
      dark:
        id === "forest"
          ? definition.dark
          : createThemePaletteFixture({
              background: "#211710",
              foreground: "#faead7",
              card: "#2c1e15",
              "card-foreground": "#faead7",
              primary: "#e6b478",
              accent: "#b86945",
            }),
      light:
        id === "forest"
          ? undefined
          : createThemePaletteFixture({
              background: id === "forest" ? "#eef4ea" : "#fcf1e8",
              foreground: "#21352b",
              card: "#fffaf0",
              "card-foreground": "#21352b",
              primary: "#8a631e",
              "primary-foreground": "#fffaf0",
              accent: "#366548",
              "muted-foreground": "#576650",
              border: "#b9c6af",
              input: "#b9c6af",
            }),
    },
    artwork: {
      backgrounds: Object.fromEntries(
        ["light", "dark"].map((mode) => [
          mode,
          {
            url:
              "/__openclaw__/plugin-theme-art/landscapes/" +
              id +
              "/background/" +
              mode +
              "?v=fixture",
          },
        ]),
      ),
    },
  }),
);
const themes = [artemis, ...pack];

suite.define(() => {
  it("shows installed palettes and artwork without selecting themes or sending chat", async () => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1100 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const plugin = {
      ...calendarPlugin,
      id: "artemis-canopy-theme",
      name: "Artemis Canopy",
      description: definition.description,
    };
    const landscape = {
      ...plugin,
      id: "landscapes",
      name: "Landscapes",
      description: "Two landscapes for your workspace.",
    };
    const inspection = {
      ...calendarInspection,
      plugin,
      declared: createPluginDeclaredSurface(),
      components: { ...calendarInspection.components, mapped: [], skills: [], mcpServers: [] },
    };
    const current = { id: "knot", mode: "dark", scope: "gateway", overrides: {} };
    let paletteReads = 0;
    let failArtemis = false;
    const gateway = await installMockGateway(
      page,
      {
        featureMethods: [...pluginMethods, "themes.list", "themes.get"],
        methodResponses: {
          ...pluginMethodResponses(),
          "config.get": themeConfigResponse("knot", "dark"),
          "plugins.list": inventory([plugin, landscape]),
          "plugins.inspect": inspection,
          "themes.list": {
            current,
            theme: BUILTIN_THEMES[1],
            themes: [...BUILTIN_THEMES, ...themes],
          },
        },
      },
      {
        requestHandlers: {
          "themes.get": async (params) => {
            paletteReads++;
            if (failArtemis && requireRecord(params, "theme request").id === artemis.id) {
              throw new Error("Theme palette temporarily unavailable");
            }
            const theme = themes.find(
              (entry) => entry.id === requireRecord(params, "theme request").id,
            )!;
            return { current, theme, definition: theme.definition };
          },
        },
      },
    );
    const requestedArt: string[] = [];
    await page.route("**/__openclaw__/plugin-theme-art/**", (route) => {
      const mode = route.request().url().includes("/light?") ? "light" : "dark";
      const name = route.request().url().includes("/forest/") ? "claw" : "miami";
      requestedArt.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        contentType: "image/webp",
        body: readFileSync(path.resolve("ui/src/assets/themes/" + name + "-" + mode + ".webp")),
      });
    });
    const capture = async (name: string, selector: string) => {
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
        return;
      }
      const surface = page.locator(selector);
      const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
        animations: "disabled",
        elements: [surface],
      });
      writeFileSync(path.join(suite.artifactDir, "after-" + name + ".png"), frame.png);
    };
    await page.goto(suite.server.baseUrl + "settings/appearance");
    const chip = page.locator('[data-theme-id="' + artemis.id + '"] .settings-theme-card__swatch');
    await expect
      .poll(() => chip.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(6, 16, 9)");
    await capture("appearance-dark", ".settings-theme-grid");
    failArtemis = true;
    await page.goto(suite.server.baseUrl + "settings/plugins/" + plugin.id);
    await page.getByRole("heading", { name: plugin.name, exact: true }).waitFor();
    await page.getByText(/Theme palette temporarily unavailable/u).waitFor();
    expect(await page.locator(".plugin-theme-preview .skeleton").count()).toBe(0);
    failArtemis = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator(".plugin-theme-preview").waitFor();
    expect(
      await page.locator(".plugin-catalog-detail__icon .settings-theme-card__swatch").count(),
    ).toBe(1);
    await expect
      .poll(() =>
        page
          .locator(".plugin-theme-preview__chat")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(6, 16, 9)");
    await capture("artemis-dark", ".plugin-catalog-detail");
    await gateway.setMethodResponse("plugins.inspect", { ...inspection, plugin: landscape });
    await page.goto(suite.server.baseUrl + "settings/plugins/" + landscape.id);
    await page.getByRole("heading", { name: landscape.name, exact: true }).waitFor();
    await expect.poll(() => page.locator(".plugin-theme-preview__background img").count()).toBe(2);
    expect(await page.locator(".plugin-catalog-detail__icon .plugins-tile").count()).toBe(1);
    expect(requestedArt.every((url) => url.endsWith("/dark"))).toBe(true);
    await expect
      .poll(() =>
        page
          .locator(".plugin-theme-preview__background img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth === 1600 &&
                image.getBoundingClientRect().height > 100,
            ),
          ),
      )
      .toBe(true);
    await capture("pack-dark", ".plugin-catalog-detail");
    await gateway.setMethodResponse("config.get", themeConfigResponse("knot", "light"));
    await gateway.emitGatewayEvent("config.changed", {});
    await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
    await expect.poll(() => requestedArt.filter((url) => url.endsWith("/light")).length).toBe(1);
    expect(requestedArt.filter((url) => url.endsWith("/dark"))).toHaveLength(2);
    expect(
      await page
        .locator(".plugin-theme-preview__chat")
        .first()
        .evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          scheme: getComputedStyle(element).colorScheme,
        })),
    ).toEqual({ background: "rgb(6, 16, 9)", scheme: "dark" });
    await capture("pack-light", ".plugin-catalog-detail");
    expect(paletteReads).toBe(12);
    expect((await gateway.getRequests("config.patch")).length).toBe(0);
    expect((await gateway.getRequests("chat.send")).length).toBe(0);
  });
});
