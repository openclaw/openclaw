import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiBundledGatewayUrl,
  waitForControlUiRoute,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse, patchPrefs } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme inspection" });
let artifacts: string | undefined;
async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  artifacts ??= createControlUiE2eArtifactDir("theme-inspection-inline");
  const section = page.locator("#settings-appearance-theme");
  const frame = await takeControlUiScreenshotFrame(page, section, [section], {
    animations: "disabled",
    scrollTo: section,
    elements: [section],
  });
  fs.writeFileSync(path.join(artifacts, name + ".png"), frame.png);
  fs.writeFileSync(path.join(artifacts, name + "-picker.png"), frame.elements[0]!.png);
}

suite.define(() => {
  it("inspects locally, previews explicitly, and saves only the theme without clearing customization", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1440, height: 1100 } },
      async ({ context, page }) => {
        const prefs = {
          theme: "claw",
          themeMode: "dark",
          accent: "#52c99a",
          fontUi: "geist",
          fontChat: "lora",
        };
        await context.addInitScript(
          ({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)),
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            settings: { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), ...prefs },
          },
        );
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(prefs, "inspection"),
            "config.patch": { ok: true },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(page);
        const root = page.locator("html");
        const grid = page.getByRole("radiogroup", { name: "Theme choices", exact: true });
        const tide = grid.getByRole("radio", { name: "Tide", exact: true });
        const saved = () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
            controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          );
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("claw");
        await capture(page, "after-resting");
        expect(await page.locator(".settings-theme-miniature").count()).toBe(0);
        const bounds = await grid.boundingBox();
        await grid.getByRole("radio", { name: "Claw", exact: true }).hover();
        await expect
          .poll(() =>
            page
              .frameLocator(".settings-theme-miniature iframe")
              .locator("html")
              .getAttribute("data-theme"),
          )
          .toBe("dark");
        await expect
          .poll(() =>
            page
              .frameLocator(".settings-theme-miniature iframe")
              .locator("body")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          )
          .toBe("rgb(14, 16, 21)");
        await tide.hover();
        await page.locator(".settings-theme-miniature iframe").waitFor();
        await expect
          .poll(() =>
            page
              .frameLocator(".settings-theme-miniature iframe")
              .locator("html")
              .getAttribute("data-theme"),
          )
          .toBe("tide");
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("claw");
        const expanded = await grid.boundingBox();
        expect(expanded?.width).toBe(bounds?.width);
        expect(expanded!.height).toBeGreaterThan(bounds!.height);
        const assertInlineLayout = async () => {
          const layout = await grid.evaluate((element) => {
            const panel = element.querySelector(".settings-theme-miniature")!;
            const panelBox = panel.getBoundingClientRect();
            const cards = [...element.querySelectorAll(".settings-theme-card")].map((card) => {
              const box = card.getBoundingClientRect();
              return {
                value: card.querySelector("input")!.value,
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                right: box.right,
              };
            });
            return {
              direct: panel.parentElement === element,
              panel: {
                top: panelBox.top,
                bottom: panelBox.bottom,
                left: panelBox.left,
                right: panelBox.right,
              },
              cards,
            };
          });
          expect(layout.direct).toBe(true);
          const inspected = layout.cards.find((card) => card.value === "tide")!;
          expect(layout.panel.top).toBeGreaterThanOrEqual(inspected.bottom);
          for (const card of layout.cards) {
            const overlap =
              Math.min(card.bottom, layout.panel.bottom) > Math.max(card.top, layout.panel.top) &&
              Math.min(card.right, layout.panel.right) > Math.max(card.left, layout.panel.left);
            expect(overlap).toBe(false);
          }
        };
        await expect
          .poll(async () => {
            await assertInlineLayout();
            return true;
          })
          .toBe(true);
        await page.setViewportSize({ width: 520, height: 1100 });
        await expect
          .poll(async () => {
            await assertInlineLayout();
            return true;
          })
          .toBe(true);
        await page.setViewportSize({ width: 1440, height: 1100 });
        await expect
          .poll(async () => {
            await assertInlineLayout();
            return true;
          })
          .toBe(true);
        await capture(page, "after-inspection");
        await page.getByRole("button", { name: "Close inspection", exact: true }).click();
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(0);
        expect(await tide.evaluate((input) => input === document.activeElement)).toBe(true);
        await grid.getByRole("radio", { name: "Claw", exact: true }).focus();
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(1);
        await page.keyboard.press("Escape");
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(0);
        expect(new URL(page.url()).pathname).toBe("/settings/appearance");
        await tide.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => grid.locator("input:checked").inputValue()).toBe("beacon");
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("claw");
        await tide.check();
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(await gateway.getRequests("themes.set")).toEqual([]);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        await page.getByRole("button", { name: "Preview theme", exact: true }).click();
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("tide");
        await expect.poll(saved).toMatchObject(prefs);
        await capture(page, "after-window-preview");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("claw");
        await page.getByRole("button", { name: "Preview theme", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("claw");
        await page.getByRole("button", { name: "Preview theme", exact: true }).click();
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("tide");
        const next = configResponse({ ...prefs, theme: "tide" }, "inspection-applied");
        await gateway.setMethodResponse("config.patch", {
          ok: true,
          config: next.config,
          hash: next.hash,
        });
        await page.getByRole("button", { name: "Apply theme", exact: true }).click();
        const request = await gateway.waitForRequest("config.patch");
        expect(patchPrefs(request)).toEqual({ theme: "tide" });
        await expect.poll(saved).toMatchObject({ ...prefs, theme: "tide" });
        await grid.getByRole("radio", { name: "Dash", exact: true }).check();
        await page.getByRole("button", { name: "Preview theme", exact: true }).click();
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("dash");
        await page.getByRole("link", { name: "Profile", exact: true }).click();
        await expect.poll(() => root.getAttribute("data-theme-id")).toBe("tide");
      },
    );
  });

  it("keeps touch inspection and keyboard focus usable without applying", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
        locale: "en-US",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse({ theme: "claw", themeMode: "light" }, "touch-inspection"),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiRoute(page, { routeId: "appearance" });
        await page.locator(".settings-theme-grid").waitFor();
        const tide = page
          .getByRole("radiogroup", { name: "Theme choices", exact: true })
          .getByRole("radio", { name: "Tide", exact: true });
        await tide.tap();
        await expect.poll(() => tide.isChecked()).toBe(true);
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("claw");
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(1);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          artifacts ??= createControlUiE2eArtifactDir("theme-inspection-inline");
          const panel = page.locator(".settings-theme-miniature");
          const frame = await takeControlUiScreenshotFrame(
            page,
            panel,
            [panel, tide.locator("..")],
            { animations: "disabled", scrollTo: panel },
          );
          fs.writeFileSync(path.join(artifacts, "after-inline-mobile.png"), frame.png);
        }
        await page.getByRole("button", { name: "Close inspection", exact: true }).tap();
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(0);
        await tide.tap();
        await expect.poll(() => page.locator(".settings-theme-miniature").count()).toBe(1);
        await page.getByRole("button", { name: "Preview theme", exact: true }).tap();
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("tide");
        await page.getByRole("button", { name: "Cancel", exact: true }).tap();
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("claw");
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(await gateway.getRequests("themes.set")).toEqual([]);
      },
    );
  });
});
