import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { BUILTIN_THEMES } from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Appearance theme preview" });
const names = [
  "Claw",
  "Knot",
  "Dash",
  "Absolutely",
  "Tide",
  "Beacon",
  "Phosphor",
  "CRT",
  "Manuscript",
  "Rosé",
  "Miami",
];
const fixture = () => ({
  presenceUsers: [{ id: "theme-preview-user", name: "Theme demo", self: true }],
  methodResponses: {
    "config.get": configSnapshot(
      { ui: { prefs: { theme: "claw", themeMode: "dark", locale: "en" } } },
      "theme-preview",
    ),
    "users.prefs.set": { status: "ok" },
  },
});

suite.define(() => {
  it("previews this window on hover and arrows, restores on Escape or exit, and writes only on Apply or Enter", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 1200 },
      },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, fixture());
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(page);
        const section = page.locator("#settings-appearance-theme");
        const group = section.getByRole("radiogroup", { name: "Theme preview" });
        await expect.poll(() => group.getByRole("radio").count()).toBe(11);
        for (const name of names) {
          expect(await group.getByRole("radio", { name, exact: true }).count()).toBe(1);
        }
        const capture = async (stage: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(page, section, [group], {
            elements: [section],
            animations: "disabled",
            scrollTo: section,
          });
          await writeFile(`${suite.artifactDir}/appearance-window-preview-${stage}.png`, frame.png);
          await writeFile(
            `${suite.artifactDir}/appearance-picker-${stage}.png`,
            frame.elements[0]!.png,
          );
        };
        await capture("before");
        const tide = group.getByRole("radio", { name: "Tide", exact: true });
        const current = () => page.locator("html").getAttribute("data-theme-id");
        await tide.hover();
        await expect.poll(current).toBe("tide");
        await expect
          .poll(() => section.getByRole("status").textContent())
          .toContain("Previewing Tide — not saved");
        expect(await gateway.getRequests("themes.set")).toEqual([]);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        await capture("after");
        // A second browser window shares storage but must not inherit a local preview.
        const other = await context.newPage();
        await installMockGateway(other, fixture());
        await other.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(other);
        expect(await other.locator("html").getAttribute("data-theme-id")).toBe("claw");
        await other.close();
        await tide.focus();
        await page.keyboard.press("Escape");
        await expect.poll(current).toBe("claw");
        expect(await tide.evaluate((element) => element === document.activeElement)).toBe(true);
        const claw = group.getByRole("radio", { name: "Claw", exact: true });
        await claw.focus();
        await expect.poll(current).toBe("claw");
        for (const [key, id] of [
          ["ArrowRight", "knot"],
          ["ArrowDown", "dash"],
          ["ArrowLeft", "knot"],
          ["ArrowUp", "claw"],
          ["End", "miami"],
          ["Home", "claw"],
        ]) {
          await page.keyboard.press(key!);
          await expect.poll(current).toBe(id);
        }
        expect(await gateway.getRequests("themes.set")).toEqual([]);
        await section.getByRole("button", { name: "Import", exact: true }).click();
        const importField = section.locator("[data-custom-theme-import-input]");
        await importField.fill("amethyst-haze");
        await importField.press("Home");
        await importField.press("ArrowRight");
        await importField.press("Enter");
        expect(await gateway.getRequests("themes.set")).toEqual([]);
        await tide.focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            gateway.getRequests("themes.set").then((requests) => requests.map((r) => r.params)),
          )
          .toEqual([{ id: "tide", appearance: { accent: "theme", fontUi: null, fontChat: null } }]);
        await expect
          .poll(() => section.getByRole("status").textContent())
          .toContain("Current: Tide");
        await group.getByRole("radio", { name: "Beacon", exact: true }).hover();
        await expect.poll(current).toBe("beacon");
        await section.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect.poll(current).toBe("tide");
        const plugin = {
          id: "preview-pack/night",
          name: "Preview Night",
          description: "A plugin preview",
          source: "plugin",
          pluginId: "preview-pack",
          modes: ["dark"],
        };
        const pluginCatalog = {
          current: { id: "tide", mode: "dark", scope: "profile", overrides: {} },
          theme: BUILTIN_THEMES.find((theme) => theme.id === "tide"),
          themes: [...BUILTIN_THEMES, plugin],
        };
        await gateway.setMethodResponse("themes.list", pluginCatalog);
        await gateway.setMethodResponse("themes.get", {
          ...pluginCatalog,
          theme: plugin,
          definition: {
            name: plugin.name,
            description: plugin.description,
            dark: createThemePaletteFixture({ background: "#121826", primary: "#a78bfa" }),
          },
        });
        await gateway.emitGatewayEvent("plugins.changed", {});
        await group.getByRole("radio", { name: "Preview Night", exact: true }).hover();
        await expect.poll(current).toBe(plugin.id);
        await expect
          .poll(() =>
            page
              .locator("html")
              .evaluate((element) => getComputedStyle(element).getPropertyValue("--bg").trim()),
          )
          .toBe("#121826");
        expect(await gateway.getRequests("themes.set")).toHaveLength(1);
        await gateway.setMethodResponse("themes.list", {
          ...pluginCatalog,
          themes: BUILTIN_THEMES,
        });
        await gateway.emitGatewayEvent("plugins.changed", {});
        await expect.poll(current).toBe("tide");
        await group.getByRole("radio", { name: "Miami", exact: true }).hover();
        await expect.poll(current).toBe("miami");
        await page.getByRole("link", { name: "Notifications", exact: true }).click();
        await expect.poll(current).toBe("tide");
        expect(await gateway.getRequests("themes.set")).toHaveLength(1);
      },
    );
  });

  it("lets touch users preview, cancel, and explicitly apply without overflowing", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 1000 },
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, fixture());
        await page.goto(suite.server.baseUrl + "settings/appearance");
        const section = page.locator("#settings-appearance-theme");
        const tide = section.getByRole("radio", { name: "Tide", exact: true });
        await tide.tap();
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("tide");
        expect(await gateway.getRequests("themes.set")).toEqual([]);
        await section.getByRole("button", { name: "Cancel", exact: true }).tap();
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("claw");
        await tide.tap();
        await section.getByRole("button", { name: "Apply theme", exact: true }).tap();
        await expect
          .poll(() => gateway.getRequests("themes.set").then((requests) => requests.length))
          .toBe(1);
        await page.getByRole("radio", { name: "Light", exact: true }).tap();
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        expect(
          await section.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.emulateMedia({ forcedColors: "active" });
        await tide.focus();
        expect(
          await tide.locator("..").evaluate((element) => getComputedStyle(element).outlineStyle),
        ).not.toBe("none");
      },
    );
  });
});
