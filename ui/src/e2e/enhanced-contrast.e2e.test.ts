import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { BUILTIN_THEME_IDS } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Enhanced built-in contrast" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifacts: string | undefined;
const pairs = [
  ...["--bg", "--card", "--popover", "--bg-muted", "--panel-hover"].flatMap(
    (surface) =>
      [
        ["--muted", surface, 7],
        ["--link", surface, 7],
        ["--border", surface, 3],
        ["--input", surface, 3],
        ["--border-hover", surface, 3],
        ["--ring", surface, 3],
      ] as const,
  ),
  ["--primary-foreground", "--primary", 7],
  ["--primary-foreground", "--primary-hover", 7],
  ["--accent-foreground", "--accent", 7],
  ["--accent-foreground", "--accent-hover", 7],
  ["--destructive-foreground", "--destructive", 7],
  ["--destructive-foreground", "--destructive-hover", 7],
  ["--ok", "--ok-subtle", 7],
  ["--warn", "--warn-subtle", 7],
  ["--danger", "--danger-subtle", 7],
  ["--info", "--info-subtle", 7],
  ["--hljs-addition", "--ok-subtle", 7],
  ["--hljs-deletion", "--danger-subtle", 7],
] as const;
const identityTokens = [
  "--font-body",
  "--font-chat",
  "--text",
  "--chat-text",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--lobster-icon-body",
];
async function palette(page: Page) {
  const raw = await page.evaluate(
    ({ tokens, identity }) => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      const probe = document.createElement("span");
      root.append(probe);
      const colors = Object.fromEntries(
        tokens.map((token) => {
          probe.style.color = "var(" + token + ")";
          return [token, getComputedStyle(probe).color];
        }),
      );
      probe.remove();
      return {
        colors,
        identity: Object.fromEntries(
          identity.map((token) => [token, styles.getPropertyValue(token)]),
        ),
      };
    },
    { tokens: [...new Set(pairs.flatMap(([fg, bg]) => [fg, bg]))], identity: identityTokens },
  );
  return { colors: await page.evaluate(resolveRenderedColors, raw.colors), identity: raw.identity };
}
function over(fg: RenderedColor, bg: RenderedColor): RenderedColor {
  return {
    red: fg.red * fg.alpha + bg.red * (1 - fg.alpha),
    green: fg.green * fg.alpha + bg.green * (1 - fg.alpha),
    blue: fg.blue * fg.alpha + bg.blue * (1 - fg.alpha),
    alpha: 1,
  };
}
function luminance(c: RenderedColor) {
  const linear = (n: number) =>
    n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4;
  return linear(c.red) * 0.2126 + linear(c.green) * 0.7152 + linear(c.blue) * 0.0722;
}
function measurements(colors: Record<string, RenderedColor>) {
  return pairs.map(([fg, bg, minimum]) => {
    const background = over(colors[bg]!, colors["--bg"]!);
    const a = luminance(over(colors[fg]!, background));
    const b = luminance(background);
    return { fg, bg, minimum, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  });
}
async function screenshot(page: Page, name: string, mobile = false) {
  if (!capture) {
    return;
  }
  artifacts ??= createControlUiE2eArtifactDir("enhanced-contrast");
  const row = page.getByRole("radiogroup", { name: "Contrast", exact: true });
  const frame = await takeControlUiScreenshotFrame(page, row, [row], {
    animations: "disabled",
    scrollTo: row,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  });
  fs.writeFileSync(path.join(artifacts, name + ".png"), frame.png);
}

suite.define(() => {
  it.for(
    BUILTIN_THEME_IDS.flatMap((theme) =>
      (["dark", "light"] as const).map((mode) => ({ theme, mode })),
    ),
  )(
    "keeps $theme/$mode authored identity and measures enhanced pairs in the actual cascade",
    async ({ theme, mode }) => {
      await suite.withPage(
        {
          viewport: { width: 1440, height: 1000 },
          locale: "en-US",
          serviceWorkers: "block",
          colorScheme: mode,
          contrast: "more",
        },
        async ({ page, context }) => {
          const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
          await context.addInitScript(
            ({ key, settings }) => {
              if (!sessionStorage.getItem("contrast-seeded")) {
                localStorage.setItem(key, JSON.stringify(settings));
                sessionStorage.setItem("contrast-seeded", "1");
              }
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              settings: {
                gatewayUrl,
                theme,
                themeMode: mode,
                contrast: "standard",
                accent: "theme",
              },
            },
          );
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "config.get": configResponse(
                { theme, themeMode: mode, accent: "theme" },
                "contrast-fixture",
              ),
            },
          });
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await waitForControlUiSettingsTakeover(page);
          const root = page.locator("html");
          const group = page.getByRole("radiogroup", { name: "Contrast", exact: true });
          await expect.poll(() => root.getAttribute("data-contrast")).toBe("standard");
          const before = await palette(page);
          await screenshot(page, theme + "-" + mode + "-before");
          if (mode === "dark") {
            await screenshot(page, theme + "-mobile-before", true);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
          await group.getByRole("radio", { name: "Enhanced", exact: true }).check();
          await expect.poll(() => root.getAttribute("data-contrast")).toBe("enhanced");
          const after = await palette(page);
          expect(after.identity).toEqual(before.identity);
          if (theme === "beacon") {
            for (const token of [
              "--muted",
              "--primary",
              "--primary-hover",
              "--link",
              "--ring",
              "--ok",
              "--warn",
              "--danger",
              "--info",
            ]) {
              expect(after.colors[token], token).toEqual(before.colors[token]);
            }
          }
          const measured = measurements(after.colors);
          if (capture) {
            artifacts ??= createControlUiE2eArtifactDir("enhanced-contrast");
            fs.writeFileSync(
              path.join(artifacts, theme + "-" + mode + ".json"),
              JSON.stringify(measured, null, 2),
            );
          }
          expect(
            measured.filter((pair) => pair.ratio < pair.minimum),
            theme + "/" + mode,
          ).toEqual([]);
          await screenshot(page, theme + "-" + mode + "-after");
          if (mode === "dark") {
            await screenshot(page, theme + "-mobile-after", true);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
          await page.reload();
          await waitForControlUiSettingsTakeover(page);
          await expect.poll(() => root.getAttribute("data-contrast")).toBe("enhanced");
          await group.getByRole("radio", { name: "Standard", exact: true }).check();
          await expect.poll(() => root.getAttribute("data-contrast")).toBe("standard");
          expect((await palette(page)).colors).toEqual(before.colors);
          if (theme === "claw" && mode === "dark") {
            await group.getByRole("radio", { name: "System", exact: true }).check();
            await expect.poll(() => root.getAttribute("data-contrast")).toBe("enhanced");
            await page.getByText("Currently using Enhanced contrast.", { exact: false }).waitFor();
            await page.emulateMedia({ contrast: "no-preference" });
            await expect.poll(() => root.getAttribute("data-contrast")).toBe("standard");
            await page.getByText("Currently using Standard contrast.", { exact: false }).waitFor();
            await group.getByRole("radio", { name: "Enhanced", exact: true }).check();
            await page.keyboard.press("Tab");
            await group.getByRole("radio", { name: "Enhanced", exact: true }).focus();
            const focus = group.locator("label:has(input:focus-visible)");
            await expect
              .poll(() => focus.evaluate((element) => getComputedStyle(element).boxShadow))
              .toContain("5px");
          }
          expect(await gateway.getRequests("themes.set")).toEqual([]);
          expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        },
      );
    },
  );
  it.for(["dark", "light"] as const)(
    "retains chat content and verifies enhanced composer states in %s",
    async (mode) => {
      await suite.withPage(
        {
          viewport: { width: 1440, height: 1000 },
          locale: "en-US",
          serviceWorkers: "block",
          colorScheme: mode,
          contrast: "more",
        },
        async ({ page, context }) => {
          const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
          await context.addInitScript(
            ({ key, settings }) => {
              if (!sessionStorage.getItem("chat-contrast-seeded")) {
                localStorage.setItem(key, JSON.stringify(settings));
                sessionStorage.setItem("chat-contrast-seeded", "1");
              }
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              settings: { gatewayUrl, theme: "claw", themeMode: mode, contrast: "standard" },
            },
          );
          await installMockGateway(page, {
            agentModel: "example/demo",
            models: [{ id: "demo", name: "Demo model", provider: "example" }],
            sessions: [
              {
                key: "agent:main:main",
                label: "Release checklist",
                model: "demo",
                modelProvider: "example",
              },
            ],
            historyMessages: [
              { role: "user", content: "Can you summarize the release checklist?" },
              {
                role: "assistant",
                content:
                  "## Release checklist\n\nKeep the same workspace, with clearer secondary text and controls.\n\n- Keyboard navigation is ready.\n- Review the remaining browser checks.\n\n\n```diff\n+ Clear control boundaries\n- Faint focus indicators\n```\n\n[Review notes](https://example.com/review) · Ready for the next check.",
              },
            ],
            methodResponses: {
              "config.get": configResponse(
                { theme: "claw", themeMode: mode },
                "chat-contrast-fixture",
              ),
            },
          });
          const input = page.locator(".agent-chat__composer-combobox textarea");
          const composer = page.locator(".agent-chat__input").first();
          const message = page.getByRole("heading", { name: "Release checklist", exact: true });
          const chatCapture = async (stage: string) => {
            if (!capture) {
              return;
            }
            artifacts ??= createControlUiE2eArtifactDir("enhanced-contrast");
            await page.mouse.move(0, 0);
            const frame = await takeControlUiScreenshotFrame(page, composer, [input, message], {
              animations: "disabled",
            });
            fs.writeFileSync(
              path.join(artifacts, "chat-" + mode + "-" + stage + ".png"),
              frame.png,
            );
          };
          await page.goto(suite.server.baseUrl + "chat");
          await message.waitFor();
          await input.fill("Check keyboard focus and the next action.");
          await chatCapture("before");
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await waitForControlUiSettingsTakeover(page);
          await page
            .getByRole("radiogroup", { name: "Contrast", exact: true })
            .getByRole("radio", { name: "Enhanced", exact: true })
            .check();
          await page.goto(suite.server.baseUrl + "chat");
          await message.waitFor();
          await input.fill("Check keyboard focus and the next action.");
          await expect
            .poll(() => page.locator("html").getAttribute("data-contrast"))
            .toBe("enhanced");
          await input.blur();
          const boundary = await composer.evaluate((element) => ({
            edge: getComputedStyle(element).borderTopColor,
            surface: getComputedStyle(element).backgroundColor,
          }));
          const boundaryColors = await page.evaluate(resolveRenderedColors, boundary);
          const edgeLuminance = luminance(over(boundaryColors.edge!, boundaryColors.surface!));
          const surfaceLuminance = luminance(boundaryColors.surface!);
          expect(
            (Math.max(edgeLuminance, surfaceLuminance) + 0.05) /
              (Math.min(edgeLuminance, surfaceLuminance) + 0.05),
          ).toBeGreaterThanOrEqual(3);
          await input.focus();
          await expect
            .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
            .toContain("5px");
          const send = page.getByRole("button", { name: "Send message", exact: true });
          const tones: string[] = [];
          for (const state of ["rest", "hover", "pressed"]) {
            if (state !== "rest") {
              await send.hover();
            }
            if (state === "pressed") {
              await page.mouse.down();
            }
            const raw = await send.evaluate((element) => ({
              foreground: getComputedStyle(element).color,
              background: getComputedStyle(element).backgroundColor,
            }));
            const colors = await page.evaluate(resolveRenderedColors, raw);
            const a = luminance(colors.foreground!);
            const b = luminance(colors.background!);
            expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(7);
            tones.push(raw.background);
          }
          await page.mouse.move(0, 0);
          await page.mouse.up();
          expect(tones[0]).not.toBe(tones[1]);
          await chatCapture("after");
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await waitForControlUiSettingsTakeover(page);
          await page
            .getByRole("radiogroup", { name: "Contrast", exact: true })
            .getByRole("radio", { name: "Standard", exact: true })
            .check();
          await page.emulateMedia({ forcedColors: "active" });
          expect(
            await page
              .locator(".shell")
              .evaluate((element) => getComputedStyle(element).backgroundImage),
          ).toBe("none");
          await page.emulateMedia({ forcedColors: "none" });
          await expect
            .poll(() => page.locator("html").getAttribute("data-contrast"))
            .toBe("standard");
        },
      );
    },
  );
});
