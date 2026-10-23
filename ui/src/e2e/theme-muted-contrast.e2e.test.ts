import type { Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { openPicker, pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { configSnapshot, settingsPageOptions } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const themeCases = [
  ["claw", "dark", "light"],
  ["knot", "openknot", "openknot-light"],
  ["dash", "dash", "dash-light"],
  ["absolutely", "absolutely", "absolutely-light"],
  ["tide", "tide", "tide-light"],
  ["beacon", "beacon", "beacon-light"],
  ["phosphor", "phosphor", "phosphor-light"],
  ["crt", "crt", "crt-light"],
  ["manuscript", "manuscript", "manuscript-light"],
  ["rose", "rose", "rose-light"],
  ["miami", "miami", "miami-light"],
] as const;
const appearances = themeCases.flatMap(([family, dark, light]) => [
  { family, mode: "dark" as const, resolved: dark },
  { family, mode: "light" as const, resolved: light },
]);

const textTokens = [
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
] as const;

const surfaceTokens = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

function themeConfigResponse(
  family: (typeof themeCases)[number][0],
  mode: "dark" | "light",
  accent?: string,
) {
  const config = {
    ui: {
      prefs: {
        ...(family === "claw" ? {} : { theme: family }),
        themeMode: mode,
        ...(accent === undefined ? {} : { accent }),
      },
    },
  };
  const hash = `theme-contrast-${family}-${mode}-${accent ?? "default"}`;
  return configSnapshot(config, hash, true);
}

const expectCommittedConfig = (page: Page, committed: ReturnType<typeof themeConfigResponse>) =>
  expect
    .poll(() =>
      evaluateControlUiContext(page, (context) => context.runtimeConfig.state.configSnapshot),
    )
    .toMatchObject({ config: committed.config, hash: committed.hash });

function compositeColor(foreground: RenderedColor, background: RenderedColor): RenderedColor {
  if (background.alpha !== 1) {
    throw new Error("Cannot measure rendered contrast against a transparent background");
  }
  const blend = (front: number, back: number) =>
    front * foreground.alpha + back * (1 - foreground.alpha);
  return {
    alpha: 1,
    blue: blend(foreground.blue, background.blue),
    green: blend(foreground.green, background.green),
    red: blend(foreground.red, background.red),
  };
}

function relativeLuminance(resolved: RenderedColor): number {
  if (resolved.alpha !== 1) {
    throw new Error("Composite a translucent rendered color before calculating contrast");
  }
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear(resolved.red) + 0.7152 * linear(resolved.green) + 0.0722 * linear(resolved.blue)
  );
}

function expectContrast(front: RenderedColor, back: RenderedColor, label: string, min = 4.5) {
  const first = relativeLuminance(front);
  const second = relativeLuminance(back);
  const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  expect(ratio, label).toBeGreaterThanOrEqual(min);
}

let appearanceFixture: {
  page: Page;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
};
const suite = createControlUiE2eSuite({
  name: "Control UI browser-rendered muted theme contrast",
  resources: {
    run: async () => {
      const context = await suite.newBrowserContext(pageOptions("dark"));
      const page = await context.newPage();
      await installControlUiE2eRendererStallProbe(page);
      const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
        key: `openclaw.control.settings.v1:${gatewayUrl}`,
        value: JSON.stringify({ gatewayUrl, theme: "knot", themeMode: "dark" }),
      });
      const gateway = await installMockGateway(page, {
        methodResponses: { "config.get": themeConfigResponse("knot", "dark") },
      });
      appearanceFixture = { page, gateway };
      await page.goto(`${suite.server.baseUrl}settings/about`);
      await waitForControlUiRoute(page, { routeId: "about" });
    },
  },
});
const pageOptions = (colorScheme: "dark" | "light") => ({
  ...settingsPageOptions,
  colorScheme,
  viewport: { height: 900, width: 1440 },
});

suite.define(() => {
  it("measures modern rendered colors in sRGB", async () => {
    await suite.withPage({}, async ({ page }) => {
      const rendered = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        // Captured from an actual theme transition; its negative Oklab channel
        // cannot be interpreted as an RGB component.
        probe.style.color = "oklab(0.731043 0.00229835 -0.00707035)";
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      expect(
        (await page.evaluate(resolveRenderedColors, { transition: rendered })).transition,
      ).toEqual({ red: 167, green: 167, blue: 173, alpha: 1 });
    });
  });

  it.for(
    appearances.flatMap(({ family, mode, resolved }) =>
      (family === "claw" ? [undefined, "#000000", "#ffffff"] : [undefined]).map((accent) => ({
        family,
        mode,
        resolved,
        accent,
      })),
    ),
  )(
    "keeps $resolved appearance and picker states legible (accent $accent)",
    async ({ family, mode, resolved, accent }, testContext) => {
      const { page, gateway } = appearanceFixture;
      let failedClose: Promise<void> | undefined;
      const closeAfterFailure = (error: unknown) => {
        failedClose ??= (async () => {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "Control UI browser-rendered muted theme contrast",
          });
          await suite.closeBrowserContext(page.context());
        })();
        return failedClose;
      };
      // The page belongs to the suite; native case cancellation must still close it.
      const onAbort = () => void closeAfterFailure(testContext.signal.reason).catch(() => {});
      testContext.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await suite.runScenario(testContext, {
          run: async () => {
            try {
              await evaluateControlUiContext(page, (context) => context.navigate("about"));
              await waitForControlUiRoute(page, { routeId: "about" });
              await page.emulateMedia({ colorScheme: mode });
              await page.mouse.move(0, 0);
              const initialFamily = family === "claw" ? "knot" : "claw";
              const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
              const preferences = { gatewayUrl, theme: initialFamily, themeMode: mode };
              await page.evaluate(
                ({ key, value }) => {
                  localStorage.clear();
                  sessionStorage.clear();
                  localStorage.setItem(key, value);
                  window.scrollTo(0, 0);
                },
                {
                  key: `openclaw.control.settings.v1:${gatewayUrl}`,
                  value: JSON.stringify(preferences),
                },
              );
              const initial = themeConfigResponse(initialFamily, mode, accent);
              await gateway.setMethodResponse("config.get", initial);
              const configGetsBeforeReset = (await gateway.getRequests("config.get")).length;
              await evaluateControlUiContext(page, async (context) => {
                await context.runtimeConfig.refresh();
                context.theme.refresh();
              });
              await expectCommittedConfig(page, initial);
              await expect
                .poll(() =>
                  evaluateControlUiContext(page, (context) => context.theme.appliedPalette),
                )
                .toMatchObject({ theme: initialFamily, resolvedMode: mode });
              await evaluateControlUiContext(page, (context) => context.navigate("appearance"));
              await waitForControlUiRoute(page, { routeId: "appearance" });
              await page
                .locator(`.settings-theme-card--${initialFamily}.settings-theme-card--active`)
                .waitFor({ state: "visible" });
              const response = await page.request.get(`${suite.server.baseUrl}settings/appearance`);
              expect(response.status()).toBe(200);

              const selectedCard = page.locator(`.settings-theme-card--${family}`);
              const root = page.locator("html");
              await selectedCard.waitFor({ state: "visible" });
              await gateway.waitForRequest("config.get", { after: configGetsBeforeReset });
              const initialConfigGets = (await gateway.getRequests("config.get")).length;
              const committed = themeConfigResponse(family, mode, "theme");
              const patchAfter = await gateway.deferNext("config.patch");
              await selectedCard.click();
              const patch = await gateway.waitForRequest("config.patch", { after: patchAfter });
              const raw = (patch.params as { raw?: unknown } | undefined)?.raw;
              expect(typeof raw).toBe("string");
              expect(JSON.parse(String(raw))).toMatchObject({
                ui: { prefs: { theme: family === "claw" ? null : family, accent: "theme" } },
              });

              const selection = async () => ({
                theme: await root.getAttribute("data-theme"),
                mode: await root.getAttribute("data-theme-mode"),
                active: (await selectedCard.getAttribute("class"))?.includes(
                  "settings-theme-card--active",
                ),
              });
              // Both optimistic paint and the acknowledgement must retain the selection.
              await expect.poll(selection).toMatchObject({ theme: resolved, active: true });

              await gateway.setMethodResponse("config.get", committed);
              await gateway.resolveDeferred("config.patch", committed);
              await expectCommittedConfig(page, committed);

              await expect.poll(selection).toEqual({ theme: resolved, mode, active: true });

              // Reapply the custom accent cleared by the theme selection.
              if (accent) {
                const accentCommitted = themeConfigResponse(family, mode, accent);
                await gateway.setMethodResponse("config.get", accentCommitted);
                const accentAfter = await gateway.deferNext("config.patch");
                await page.locator("[data-accent-custom]").fill(accent);
                const accentPatch = await gateway.waitForRequest("config.patch", {
                  after: accentAfter,
                });
                // SAFETY: This is the config.patch request emitted by the exercised picker;
                // the parsed payload below is checked against its complete prefs contract.
                expect(JSON.parse((accentPatch.params as { raw: string }).raw)).toEqual({
                  ui: { prefs: { accent } },
                });
                await gateway.resolveDeferred("config.patch", accentCommitted);
                await expectCommittedConfig(page, accentCommitted);
                await expect
                  .poll(() =>
                    page.evaluate(() =>
                      document.documentElement.style.getPropertyValue("--accent"),
                    ),
                  )
                  .toBe(accent);
              }

              await page.locator(".settings-section__desc").first().waitFor({ state: "visible" });

              const rendered = await page.evaluate(
                ({ foregroundNames, surfaceNames }) => {
                  const styles = getComputedStyle(document.documentElement);
                  const description =
                    document.querySelector<HTMLElement>(".settings-section__desc");
                  if (!description) {
                    throw new Error("The actual Appearance settings description did not render");
                  }
                  let opacity = 1;
                  const backgroundLayers: string[] = [];
                  for (
                    let ancestor: HTMLElement | null = description;
                    ancestor;
                    ancestor = ancestor.parentElement
                  ) {
                    const ancestorStyles = getComputedStyle(ancestor);
                    opacity *= Number(ancestorStyles.opacity);
                    backgroundLayers.push(ancestorStyles.backgroundColor);
                  }
                  return {
                    backgroundLayers,
                    descriptionColor: getComputedStyle(description).color,
                    descriptionOpacity: opacity,
                    tokens: Object.fromEntries(
                      [...foregroundNames, ...surfaceNames].map((name) => [
                        name,
                        styles.getPropertyValue(name).trim(),
                      ]),
                    ) as Record<string, string>,
                  };
                },
                { foregroundNames: [...textTokens], surfaceNames: [...surfaceTokens] },
              );

              const colors = await page.evaluate(resolveRenderedColors, {
                ...rendered.tokens,
                description: rendered.descriptionColor,
                ...Object.fromEntries(
                  rendered.backgroundLayers.map((color, index) => [`layer-${index}`, color]),
                ),
              });

              for (const textToken of textTokens) {
                for (const surfaceToken of surfaceTokens) {
                  expectContrast(
                    colors[textToken]!,
                    colors[surfaceToken]!,
                    `${resolved}: ${textToken} on ${surfaceToken}`,
                  );
                }
              }

              let descriptionBackground = colors["--bg"]!;
              for (let index = rendered.backgroundLayers.length - 1; index >= 0; index--) {
                descriptionBackground = compositeColor(
                  colors[`layer-${index}`]!,
                  descriptionBackground,
                );
              }
              const descriptionColor = colors.description!;
              descriptionColor.alpha *= rendered.descriptionOpacity;
              expectContrast(
                compositeColor(descriptionColor, descriptionBackground),
                descriptionBackground,
                `${resolved}: rendered Appearance description`,
              );

              const picker = page.locator("openclaw-select-picker:has(#settings-font-chat)");
              await openPicker(picker);
              const selected = picker.locator('[role="option"][aria-selected="true"]');
              await selected.waitFor({ state: "visible" });
              const optionPaint = async (option: typeof selected) => {
                await option.evaluate(finishElementAnimations);
                return option.evaluate((element) => {
                  const style = getComputedStyle(element);
                  return {
                    colors: {
                      background: style.backgroundColor,
                      label: getComputedStyle(element.querySelector(".picker-select__label")!)
                        .color,
                      description: getComputedStyle(
                        element.querySelector(".picker-select__description")!,
                      ).color,
                      outline: style.outlineColor,
                    },
                    outline: style.outlineStyle,
                    outlineWidth: Number.parseFloat(style.outlineWidth),
                  };
                });
              };
              // Composite translucent option fills against the painted menu surface.
              const listboxBackground = await picker
                .locator(".picker-select__menu")
                .evaluate((element) => getComputedStyle(element).backgroundColor);
              const assertOptionContrast = async (option: typeof selected) => {
                const paint = await optionPaint(option);
                const optionColors = await page.evaluate(resolveRenderedColors, {
                  ...paint.colors,
                  listbox: listboxBackground,
                });
                const background = compositeColor(optionColors.background!, optionColors.listbox!);
                for (const text of [optionColors.label!, optionColors.description!]) {
                  expectContrast(text, background, `${resolved} picker text`);
                }
                return { paint, background, outline: optionColors.outline! };
              };
              const selectedValue = await selected.getAttribute("data-value");
              const initialPaint = await optionPaint(selected);
              await page.keyboard.press("ArrowDown");
              const current = picker.locator('[role="option"][data-active]');
              await expect.poll(() => current.getAttribute("data-value")).not.toBe(selectedValue);
              expect(await selected.getAttribute("data-value")).toBe(selectedValue);
              await expect
                .poll(async () => (await optionPaint(selected)).colors.background)
                .toBe(initialPaint.colors.background);
              await assertOptionContrast(selected);
              const focused = await assertOptionContrast(current);
              expect(focused.paint.outline).not.toBe("none");
              expect(focused.paint.outlineWidth).toBeGreaterThanOrEqual(2);
              expectContrast(focused.outline, focused.background, `${resolved} picker outline`, 3);
              await picker.locator('[role="option"][data-value="system"]').hover();
              await assertOptionContrast(picker.locator('[role="option"][data-value="system"]'));
              await page.keyboard.press("Escape");
              expect(new URL(page.url()).pathname).toBe("/settings/appearance");
              expect(await pickerValue(picker)).toBe(selectedValue);
              expect(await gateway.getRequests("config.get")).toHaveLength(initialConfigGets);
            } catch (error) {
              void closeAfterFailure(error).catch(() => {});
              throw error;
            }
          },
          close: async () => {
            await failedClose;
          },
        });
      } finally {
        testContext.signal.removeEventListener("abort", onAbort);
      }
    },
  );
});
