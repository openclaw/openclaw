import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Filled action foregrounds" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const themes = [
  { theme: "claw", mode: "dark" },
  { theme: "claw", mode: "light" },
  { theme: "absolutely", mode: "dark" },
  { theme: "absolutely", mode: "light" },
  { theme: "crt", mode: "dark" },
  { theme: "crt", mode: "light" },
  { theme: "beacon", mode: "dark" },
  { theme: "beacon", mode: "light" },
  { theme: "claw", mode: "dark", accent: "#ffffff" },
  { theme: "claw", mode: "light", accent: "#000000" },
] satisfies Array<{ theme: string; mode: "light" | "dark"; accent?: string }>;

function composite(front: RenderedColor, back: RenderedColor): RenderedColor {
  const channel = (a: number, b: number) => a * front.alpha + b * (1 - front.alpha);
  return {
    red: channel(front.red, back.red),
    green: channel(front.green, back.green),
    blue: channel(front.blue, back.blue),
    alpha: 1,
  };
}

function contrast(front: RenderedColor, back: RenderedColor) {
  const luminance = (color: RenderedColor) => {
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
  };
  const a = luminance(front);
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function paint(button: Locator, foreground: string, background?: string) {
  await button.evaluate(finishElementAnimations);
  const raw = await button.evaluate(
    (element, tokens) => {
      const svg = element.querySelector("svg")!;
      const probe = document.createElement("span");
      element.append(probe);
      const resolve = (value: string) => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const style = getComputedStyle(element);
      const layers: string[] = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        layers.push(getComputedStyle(parent).backgroundColor);
      }
      const result = {
        button: style.color,
        svg: getComputedStyle(svg).color,
        fill: style.backgroundColor,
        expectedInk: resolve(tokens.foreground),
        expectedFill: resolve(tokens.background ?? style.backgroundColor),
        canvas: resolve("var(--bg)"),
        ...Object.fromEntries(layers.map((color, index) => [`layer-${index}`, color])),
      };
      probe.remove();
      return { result, layerCount: layers.length, width: element.getBoundingClientRect().width };
    },
    { foreground, background },
  );
  const colors = await button.page().evaluate(resolveRenderedColors, raw.result);
  let surface = colors.canvas!;
  for (let index = raw.layerCount - 1; index >= 0; index--) {
    surface = composite(colors[`layer-${index}`]!, surface);
  }
  const fill = composite(colors.fill!, surface);
  return { colors, contrast: contrast(composite(colors.svg!, fill), fill), width: raw.width };
}

async function inspectStates(page: Page, button: Locator, foreground: string, fills?: string[]) {
  const samples = [];
  for (const [index, state] of ["rest", "hover", "pressed"].entries()) {
    if (state === "rest") {
      await page.mouse.move(0, 0);
    } else {
      await button.hover();
    }
    if (state === "pressed") {
      await page.mouse.down();
    }
    try {
      const sample = await paint(button, foreground, fills?.[index]);
      expect.soft(sample.colors.button, `${state}: button ink`).toEqual(sample.colors.expectedInk);
      expect.soft(sample.colors.svg, `${state}: SVG follows button`).toEqual(sample.colors.button);
      if (fills) {
        expect
          .soft(sample.colors.fill, `${state}: selected fill`)
          .toEqual(sample.colors.expectedFill);
      }
      expect.soft(sample.contrast, `${state}: rendered icon contrast`).toBeGreaterThanOrEqual(3);
      samples.push({ state, ...sample });
    } finally {
      if (state === "pressed") {
        // Release outside the action so measuring :active cannot submit or navigate.
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    }
  }
  expect(samples.map((sample) => sample.width)).toEqual(Array(3).fill(samples[0]!.width));
  return samples;
}

async function screenshot(page: Page, name: string, targets: Locator[]) {
  if (!capture) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, targets[0]!, targets, {
    animations: "disabled",
    elements: targets,
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  for (const [index, crop] of frame.elements.entries()) {
    await writeFile(path.join(suite.artifactDir, `${name}-${index}.png`), crop.png);
  }
}

suite.define(() => {
  it.each(themes)("keeps $theme $mode action color pairs (accent $accent)", async (appearance) => {
    const { theme, mode, accent } = appearance;
    const id = `${theme}-${mode}-${accent ?? "theme"}`;
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: mode },
      async ({ page }) => {
        await seedChatSettings(page, suite.server.baseUrl, { theme, themeMode: mode, accent });
        const gateway = await installMockGateway(page, {
          agentModel: "example/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
          historyMessages: [
            { role: "assistant", content: "The draft is ready for review.", timestamp: 1 },
          ],
          methodResponses: { "config.get": configResponse({ theme, themeMode: mode, accent }, id) },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: "agent:main:main" },
        });
        const resolved = theme === "claw" ? mode : `${theme}${mode === "light" ? "-light" : ""}`;
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
        if (theme !== "claw") {
          await expect
            .poll(() =>
              page
                .locator(`#openclaw-theme-palette-${theme}`)
                .evaluate((link) => Boolean((link as HTMLLinkElement).sheet)),
            )
            .toBe(true);
        }
        const palette = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          links: [
            ...document.querySelectorAll<HTMLLinkElement>('link[id^="openclaw-theme-palette-"]'),
          ].map((link) => ({ href: link.href, loaded: Boolean(link.sheet) })),
          accent: getComputedStyle(document.documentElement).getPropertyValue("--accent"),
          primary: getComputedStyle(document.documentElement).getPropertyValue("--primary"),
        }));
        const rail = page.locator(".sidebar-rail__create .sidebar-new-session");
        const railSamples = await inspectStates(page, rail, "var(--accent-foreground)", [
          "var(--sidebar-rail-action-bg)",
          "var(--sidebar-rail-action-hover-bg)",
          "var(--sidebar-rail-action-active-bg)",
        ]);
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await textarea.fill("Review this draft.");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const desktop = await inspectStates(page, send, "var(--chat-send-foreground)");
        await screenshot(page, `${id}-desktop-send`, [page.locator(".agent-chat__input"), rail]);
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await inspectStates(page, send, "var(--chat-send-foreground)");
        await screenshot(page, `${id}-mobile-send`, [page.locator(".agent-chat__input")]);
        if (theme === "crt" && mode === "dark") {
          // An explicit theme token must reach the SVG, not only its button.
          await page.evaluate(() =>
            document.documentElement.style.setProperty("--chat-send-foreground", "#000000"),
          );
          await inspectStates(page, send, "#000000");
          await page.evaluate(() =>
            document.documentElement.style.removeProperty("--chat-send-foreground"),
          );
        }
        await send.click();
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({ message: "Review this draft." });
        const stop = page.getByRole("button", { name: "Stop generating", exact: true });
        await stop.waitFor({ state: "visible" });
        const stopMobile = await inspectStates(page, stop, "var(--danger)");
        await screenshot(page, `${id}-mobile-stop`, [page.locator(".agent-chat__input")]);
        await page.setViewportSize({ width: 1440, height: 900 });
        const stopDesktop = await inspectStates(page, stop, "var(--danger)");
        await stop.click();
        await gateway.waitForRequest("chat.abort");
        await stop.waitFor({ state: "detached" });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.setViewportSize({ width: 390, height: 844 });
        await textarea.fill("A new conversation draft.");
        const start = page.locator(".new-session-page__start-submit");
        const newSession = await inspectStates(page, start, "var(--chat-send-foreground)");
        await screenshot(page, `${id}-mobile-new`, [page.locator(".agent-chat__input")]);
        if (theme === "crt" && mode === "dark") {
          await page.evaluate(() =>
            document.documentElement.style.setProperty("--chat-send-foreground", "#000000"),
          );
          await inspectStates(page, start, "#000000");
        }
        if (capture) {
          await writeFile(
            path.join(suite.artifactDir, `${id}-colors.json`),
            JSON.stringify(
              { palette, railSamples, desktop, mobile, stopMobile, stopDesktop, newSession },
              null,
              2,
            ),
          );
        }
      },
    );
  });
});
