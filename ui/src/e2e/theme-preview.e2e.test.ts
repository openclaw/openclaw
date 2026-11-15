import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  BUILTIN_THEMES,
  type ThemeCatalogEntry,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configResponse, requireRecord } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Theme palette previews",
  trackBrowserContexts: true,
});
const plugin: ThemeCatalogEntry = {
  id: "winter/evergreen",
  name: "Evergreen",
  description: "Forest green with warm gold controls.",
  source: "plugin",
  pluginId: "winter",
  modes: ["light", "dark"],
  definition: {
    name: "Evergreen",
    description: "Forest green with warm gold controls.",
    dark: createThemePaletteFixture({
      background: "#10251c",
      foreground: "#e8f5e9",
      accent: "#6bdd98",
      primary: "#e8be62",
    }),
    light: createThemePaletteFixture({
      background: "#edf7ef",
      foreground: "#123b25",
      accent: "#257146",
      primary: "#926a16",
    }),
  },
};
const personal: ThemeCatalogEntry = {
  id: "user/lavender",
  name: "Lavender",
  description: "A light-only lavender palette.",
  source: "user",
  modes: ["light"],
  definition: {
    name: "Lavender",
    description: "A light-only lavender palette.",
    light: createThemePaletteFixture({
      background: "#f2edff",
      foreground: "#372459",
      accent: "#7650ac",
      primary: "#ad4675",
    }),
  },
};

suite.define(() => {
  it("previews each catalog palette independently of selection, accent overrides and color mode", async (testContext) => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const current = { id: "knot", mode: "dark", scope: "gateway", overrides: {} };
    let failPlugin = false;
    const paletteReady = Promise.withResolvers<void>();
    testContext.onTestFinished(() => paletteReady.resolve());
    const gateway = await installMockGateway(
      page,
      {
        methodResponses: {
          "config.get": themeConfigResponse("knot", "dark"),
          "config.patch": { ok: true },
          "themes.list": {
            current,
            theme: BUILTIN_THEMES.find((theme) => theme.id === "knot"),
            themes: [...BUILTIN_THEMES, plugin, personal],
          },
        },
      },
      {
        requestHandlers: {
          "themes.get": async (params) => {
            const id = requireRecord(params, "theme request").id;
            if (failPlugin && id === plugin.id) {
              throw new Error("Palette preview temporarily unavailable");
            }
            if (id === plugin.id) {
              await paletteReady.promise;
            }
            const theme = [plugin, personal].find((entry) => entry.id === id);
            expect(theme).toBeDefined();
            return { current, theme, definition: theme!.definition };
          },
        },
      },
    );
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    const grid = page.locator(".settings-theme-grid");
    const card = (id: string) => grid.locator(`[data-theme-id="${id}"]`);
    await card(personal.id).waitFor();
    const colors = (id: string) =>
      card(id).evaluate((element) => {
        const style = (selector: string) => getComputedStyle(element.querySelector(selector)!);
        return {
          background: style(".settings-theme-card__swatch").backgroundColor,
          accent: style(".settings-theme-card__chip--accent").backgroundColor,
          secondary: style(".settings-theme-card__chip--accent-2").backgroundColor,
        };
      });
    const capture = async (mode: string) => {
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(
        page,
        grid,
        [card(plugin.id), card(personal.id)],
        { animations: "disabled", elements: [grid] },
      );
      await writeFile(path.join(suite.artifactDir, `${mode}.png`), frame.elements[0]!.png);
    };
    // A held plugin read must not borrow the selected theme’s red accent.
    await expect.poll(async () => (await colors(plugin.id)).accent).toBe("rgb(138, 138, 148)");
    expect((await colors(plugin.id)).secondary).toBe("rgb(138, 138, 148)");
    paletteReady.resolve();
    await capture("initial-dark");
    await expect
      .poll(() => colors(plugin.id))
      .toEqual({
        background: "rgb(16, 37, 28)",
        accent: "rgb(107, 221, 152)",
        secondary: "rgb(232, 190, 98)",
      });
    const lavender = {
      background: "rgb(242, 237, 255)",
      accent: "rgb(118, 80, 172)",
      secondary: "rgb(173, 70, 117)",
    };
    expect(await colors(personal.id)).toEqual(lavender);
    await capture("dark");
    await gateway.setMethodResponse(
      "config.get",
      configResponse({ theme: "knot", themeMode: "dark", accent: "#5b9cf6" }, "preview-accent"),
    );
    await page.locator('[data-accent-preset="blue"]').click();
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((root) => getComputedStyle(root).getPropertyValue("--accent").trim()),
      )
      .toBe("#5b9cf6");
    expect((await colors(plugin.id)).accent).toBe("rgb(107, 221, 152)");
    await gateway.setMethodResponse(
      "config.get",
      configResponse({ theme: "knot", themeMode: "light", accent: "#5b9cf6" }, "preview-light"),
    );
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await expect
      .poll(() => colors(plugin.id))
      .toEqual({
        background: "rgb(237, 247, 239)",
        accent: "rgb(37, 113, 70)",
        secondary: "rgb(146, 106, 22)",
      });
    expect(await colors(personal.id)).toEqual(lavender);
    await capture("light");
    await gateway.setMethodResponse("config.get", themeConfigResponse(personal.id, "light"));
    await card(personal.id).click();
    await expect.poll(() => card(personal.id).getAttribute("aria-pressed")).toBe("true");
    expect((await colors(plugin.id)).accent).toBe("rgb(37, 113, 70)");
    expect(
      (await gateway.getRequests("themes.get"))
        .map((request) => String(requireRecord(request.params, "theme request").id))
        .toSorted(),
    ).toEqual([personal.id, plugin.id].toSorted());

    failPlugin = true;
    await gateway.emitGatewayEvent("plugins.changed", {});
    const failure = page.locator(".settings-status--error");
    await expect
      .poll(() => failure.textContent())
      .toContain("Palette preview temporarily unavailable");
    expect(await card(personal.id).getAttribute("aria-pressed")).toBe("true");
    failPlugin = false;
    await failure.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => failure.count()).toBe(0);
    expect((await colors(plugin.id)).accent).toBe("rgb(37, 113, 70)");
  });
});
