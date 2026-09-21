import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { BUILTIN_THEME_IDS } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { resolveTheme, type ThemeName } from "../app/theme.ts";
import {
  controlUiBundledGatewayUrl,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";
import {
  expectAppArtwork,
  expectComposerSurface,
  expectMobileComposer,
  readArtwork,
} from "./theme-background.test-support.ts";

const builtinThemes = BUILTIN_THEME_IDS.flatMap((family) =>
  (["dark", "light"] as const).map((mode) => ({
    family,
    mode,
    resolved: resolveTheme(family, mode),
  })),
);
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({ name: "Control UI app theme artwork" });

type ColorMode = "dark" | "light";

function themeConfig(family: ThemeName, mode: ColorMode | "system") {
  const config = {
    ui: { prefs: { theme: family === "claw" ? undefined : family, themeMode: mode } },
  };
  const hash = `theme-background-${family}-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function changeTheme(
  page: Page,
  gateway: MockGatewayControls,
  selection: { family: ThemeName; mode: ColorMode; resolved: string },
) {
  // Exercise the live preference-refresh boundary, not synthetic root attributes.
  // A synced theme change must repaint the app without resetting a mounted draft.
  const configGets = (await gateway.getRequests("config.get")).length;
  await gateway.setMethodResponse("config.get", themeConfig(selection.family, selection.mode));
  await gateway.emitGatewayEvent("config.changed", {});
  await expect
    .poll(async () => (await gateway.getRequests("config.get")).length)
    .toBeGreaterThan(configGets);
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(selection.resolved);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme-mode"))
    .toBe(selection.mode);
}

async function captureProof(page: Page, name: string, compareBefore = false) {
  if (!captureUiProof) {
    return;
  }
  const capture = (suffix: string) =>
    page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(suite.artifactDir, `${name}-${suffix}.png`),
    });
  await capture("after");
  if (compareBefore) {
    // Same DOM/content/viewport; restore only the exact pre-feature CSS rules.
    const override = await page.addStyleTag({
      content: `
      .shell { background: none !important; }
      :root[data-theme-mode="light"] .content { background: var(--bg-content) !important; }
      .agent-chat__input { background: var(--chat-composer-surface) !important;
        backdrop-filter: blur(12px) saturate(1.6) !important;
        -webkit-backdrop-filter: blur(12px) saturate(1.6) !important; }
      .agent-chat__composer-combobox > :is(textarea, input)::placeholder {
        color: var(--chat-composer-tertiary) !important; }
    `,
    });
    try {
      await capture("before");
    } finally {
      await override.evaluate((element) => element.parentNode?.removeChild(element));
    }
  }
}

suite.define(() => {
  it("shares one readable app canvas across new, chat, and settings without losing drafts", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "example/demo",
          models: [{ id: "demo", name: "Demo model", provider: "example" }],
          methodResponses: { "config.get": themeConfig("claw", "dark") },
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Help me organize a focused afternoon." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Start with one meaningful task. Close unrelated tabs and leave space for a short break.\n\n### A simple plan\n- Review the open questions.\n- Work through the most important decision.\n- Write down the next step before you finish.",
                },
              ],
            },
            {
              role: "user",
              content: [{ type: "text", text: "Keep the plan practical and easy to revisit." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "A useful plan leaves room to think. Keep your notes brief, make the next action specific, and adjust the schedule when new information arrives.\n\nYou can return to this conversation whenever you need the context.",
                },
              ],
            },
          ],
        });
        const images = new Map<string, string>();
        const decoded = new Set<string>();
        for (const route of ["new", "chat", "settings/appearance"] as const) {
          await page.goto(`${suite.server.baseUrl}${route}`);
          await gateway.waitForRequest("config.get");
          if (route === "chat") {
            await page
              .getByText("You can return to this conversation whenever you need the context.", {
                exact: true,
              })
              .waitFor({ state: "visible" });
          }
          const shell = page.locator(".shell");
          const composer =
            route === "settings/appearance" ? null : page.locator(".agent-chat__input");
          const textarea = composer?.locator("textarea");
          const draft = `An unsent ${route} draft stays here while the theme changes.`;
          if (textarea) {
            await textarea.fill(draft);
          } else {
            await page.locator(".settings-section__desc").first().waitFor({ state: "visible" });
          }
          for (const selection of route === "new"
            ? builtinThemes
            : builtinThemes.filter(({ family }) => family === "claw" || family === "dash")) {
            await changeTheme(page, gateway, selection);
            for (const viewport of ["desktop", "mobile"] as const) {
              await page.setViewportSize(
                viewport === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 },
              );
              if (textarea && composer) {
                await textarea.click();
                expect(await textarea.inputValue()).toBe(draft);
                await expectComposerSurface(composer);
                if (viewport === "mobile") {
                  await expectMobileComposer(composer);
                }
              }
              const label = `${selection.resolved}-${route.replace("/", "-")}-${viewport}`;
              const artwork = await readArtwork(shell);
              expectAppArtwork(artwork, label);
              const minimumContrast = selection.family === "beacon" ? 7 : 4.5;
              expect
                .soft(artwork.canvasContrast, `${label}: muted text on app artwork`)
                .toBeGreaterThanOrEqual(minimumContrast);
              if (composer) {
                expect
                  .soft(
                    artwork.composerContrast,
                    `${label}: placeholder contrast (opaque reference ${artwork.opaqueComposerContrast})`,
                  )
                  .toBeGreaterThanOrEqual(minimumContrast);
              }
              if (route === "chat") {
                expect(
                  artwork.transcriptContrast,
                  `${label}: conversation text on artwork`,
                ).toBeGreaterThanOrEqual(4.5);
              }
              if (route === "new" && viewport === "desktop") {
                images.set(selection.resolved, artwork.backgroundImage);
                decoded.add(artwork.pixels);
              } else {
                expect(artwork.backgroundImage, label).toBe(images.get(selection.resolved));
              }
              await captureProof(page, label, selection.family === "claw");
            }
          }
          if (composer && textarea) {
            // Glass must not obstruct real controls on either composer surface.
            await composer.getByRole("button", { name: "Add attachment", exact: true }).click();
            await composer
              .getByRole("menuitem", { name: "File", exact: true })
              .waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
          }
          await changeTheme(page, gateway, {
            family: "dash",
            mode: "light",
            resolved: "dash-light",
          });
          const background = () =>
            shell.evaluate((element) => getComputedStyle(element).backgroundImage);
          for (const media of [
            { contrast: "more", forcedColors: "none" },
            { contrast: "no-preference", forcedColors: "active" },
          ] as const) {
            await page.emulateMedia(media);
            await expect.poll(background).toBe("none");
            if (composer && textarea) {
              await expectComposerSurface(composer, true);
              expect(await textarea.inputValue()).toBe(draft);
            }
          }
          await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" });
          await expect.poll(background).toBe(images.get("dash-light"));
          if (composer && textarea) {
            // Playwright's media options do not expose reduced transparency;
            // exercise the real browser media query through Chromium's protocol.
            const session = await context.newCDPSession(page);
            try {
              await session.send("Emulation.setEmulatedMedia", {
                features: [
                  { name: "prefers-color-scheme", value: "light" },
                  { name: "prefers-reduced-transparency", value: "reduce" },
                ],
              });
              expect(
                await page.evaluate(
                  () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
                ),
              ).toBe(true);
              await expectComposerSurface(composer, true);
              expect(await background()).toBe(images.get("dash-light"));
              expect(await textarea.inputValue()).toBe(draft);
            } finally {
              await session.send("Emulation.setEmulatedMedia", { features: [] });
              await session.detach();
            }
          }
          await gateway.setMethodResponse("config.get", themeConfig("dash", "system"));
          await gateway.emitGatewayEvent("config.changed", {});
          for (const mode of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: mode });
            const resolved = mode === "dark" ? "dash" : "dash-light";
            await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
            expect(await background()).toBe(images.get(resolved));
            if (composer && textarea) {
              await expectComposerSurface(composer);
              expect(await textarea.inputValue()).toBe(draft);
            }
          }
          await page.setViewportSize({ width: 1440, height: 900 });
        }
        expect(new Set(images.values()).size).toBe(builtinThemes.length);
        expect(decoded.size).toBe(builtinThemes.length);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it("keeps custom palettes on bundled mode-specific neutral artwork instead of imported image URLs", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const imported = createImportedCustomThemeFixture();
        const externalImage = 'url("https://theme-artwork.invalid/tracker.svg")';
        await context.addInitScript(
          ({ gatewayUrl, customTheme, image }) => {
            localStorage.setItem(
              `openclaw.control.settings.v1:${gatewayUrl}`,
              JSON.stringify({
                gatewayUrl,
                theme: "custom",
                themeMode: "dark",
                customTheme: {
                  ...customTheme,
                  light: { ...customTheme.light, "app-background-image": image },
                  dark: { ...customTheme.dark, "app-background-image": image },
                },
              }),
            );
          },
          {
            gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
            customTheme: imported,
            image: externalImage,
          },
        );
        const externalRequests: string[] = [];
        await page.route("https://theme-artwork.invalid/**", async (route) => {
          externalRequests.push(route.request().url());
          await route.abort();
        });
        const gateway = await installMockGateway(page, {
          methodResponses: { "config.get": themeConfig("custom", "dark") },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input");
        await composer.locator("textarea").fill("Keep imported palettes local and quiet");
        const images = new Set<string>();
        for (const mode of ["dark", "light"] as const) {
          await changeTheme(page, gateway, {
            family: "custom",
            mode,
            resolved: mode === "dark" ? "custom" : "custom-light",
          });
          const artwork = await readArtwork(page.locator(".shell"));
          expectAppArtwork(artwork, `custom ${mode}`);
          await expectComposerSurface(composer);
          expect(artwork.maxColorSpread).toBeLessThanOrEqual(32);
          images.add(artwork.backgroundImage);
          // Removing palette declarations must not remove static bundled artwork.
          const withoutPalette = await page.locator(".shell").evaluate((element) => {
            const palette = document.querySelector<HTMLStyleElement>("#openclaw-custom-theme");
            if (!palette?.sheet) {
              throw new Error("The imported custom palette was not applied");
            }
            palette.sheet.disabled = true;
            try {
              return getComputedStyle(element).backgroundImage;
            } finally {
              palette.sheet.disabled = false;
            }
          });
          expect(withoutPalette).toBe(artwork.backgroundImage);
        }
        expect(images.size).toBe(2);
        expect(await composer.locator("textarea").inputValue()).toBe(
          "Keep imported palettes local and quiet",
        );
        expect(externalRequests).toEqual([]);
      },
    );
  });
});
