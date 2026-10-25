import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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

const suite = createControlUiE2eSuite({ name: "Control UI browser-rendered muted theme contrast" });

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
    async ({ family, mode, resolved, accent }) => {
      await suite.withPage(
        { ...settingsPageOptions, colorScheme: mode, viewport: { height: 900, width: 1440 } },
        async ({ page, context }) => {
          const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
          await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
            key: "openclaw.control.settings.v1:" + gatewayUrl,
            value: JSON.stringify({ gatewayUrl, theme: family, themeMode: mode, accent }),
          });
          await installMockGateway(page, {
            methodResponses: { "config.get": themeConfigResponse(family, mode, accent) },
          });
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await page
            .locator(".settings-theme-card--" + family + ".settings-theme-card--active")
            .waitFor();
          const root = page.locator("html");
          await expect.poll(() => root.getAttribute("data-theme")).toBe(resolved);
          expect(await root.getAttribute("data-theme-mode")).toBe(mode);
          if (accent) {
            await expect
              .poll(() => root.evaluate((element) => element.style.getPropertyValue("--accent")))
              .toBe(accent);
          }
          const rendered = await page.evaluate(
            ({ foregroundNames, surfaceNames }) => {
              const styles = getComputedStyle(document.documentElement);
              const description = document.querySelector<HTMLElement>(".settings-section__desc");
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
                  label: getComputedStyle(element.querySelector(".picker-select__label")!).color,
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
        },
      );
    },
  );
});
