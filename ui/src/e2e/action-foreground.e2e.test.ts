import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
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

async function inspectStates(
  page: Page,
  button: Locator,
  label: string,
  foreground: string,
  fills?: string[],
) {
  const samples = [];
  for (const [index, state] of ["rest", "hover", "pressed"].entries()) {
    if (state === "rest") {
      await page.mouse.move(0, 0);
    } else if (state === "hover") {
      await button.hover();
    }
    if (state === "pressed") {
      await page.mouse.down();
    }
    try {
      const sample = await paint(button, foreground, fills?.[index]);
      expect
        .soft(sample.colors.button, `${label} ${state}: button ink`)
        .toEqual(sample.colors.expectedInk);
      expect
        .soft(sample.colors.svg, `${label} ${state}: SVG follows button`)
        .toEqual(sample.colors.button);
      if (fills) {
        expect
          .soft(sample.colors.fill, `${label} ${state}: selected fill`)
          .toEqual(sample.colors.expectedFill);
      }
      expect
        .soft(sample.contrast, `${label} ${state}: rendered icon contrast`)
        .toBeGreaterThanOrEqual(3);
      samples.push({ state, ...sample });
    } finally {
      if (state === "pressed") {
        // Release outside the action so measuring :active cannot submit or navigate.
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    }
  }
  expect(
    samples.map((sample) => sample.width),
    `${label}: stable action width`,
  ).toEqual(Array(3).fill(samples[0]!.width));
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
  it("keeps action color pairs across every theme, mode, and accent", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "example/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
          historyMessages: [
            { role: "assistant", content: "The draft is ready for review.", timestamp: 1 },
          ],
          methodResponses: {
            "config.get": configResponse({ theme: "claw", themeMode: "dark" }, "claw-dark"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: "agent:main:main" },
        });
        for (const [index, { theme, mode, accent }] of themes.entries()) {
          const id = `${theme}-${mode}-${accent ?? "theme"}`;
          await page.emulateMedia({ colorScheme: mode });
          await page.setViewportSize({ width: 1440, height: 900 });
          if (index > 0) {
            // Exercise the live preference owner while reusing the mounted application.
            await gateway.setMethodResponse(
              "config.get",
              configResponse({ theme, themeMode: mode, accent }, id),
            );
            await gateway.emitGatewayEvent("config.changed", {});
            await evaluateControlUiContext(page, (app) => app.navigate("chat"));
            await waitForControlUiRoute(page, { routeId: "chat" });
          }
          const resolved = theme === "claw" ? mode : `${theme}${mode === "light" ? "-light" : ""}`;
          await expect
            .poll(() =>
              page.evaluate(() => ({
                theme: document.documentElement.dataset.theme,
                mode: document.documentElement.dataset.themeMode,
                accent: document.documentElement.style.getPropertyValue("--accent"),
              })),
            )
            .toEqual({ theme: resolved, mode, accent: accent ?? "" });
          if (theme !== "claw") {
            await expect
              .poll(() =>
                page
                  .locator(`#openclaw-theme-palette-${theme}`)
                  .evaluate((link) => Boolean((link as HTMLLinkElement).sheet)),
              )
              .toBe(true);
          }
          const palette = capture
            ? await page.evaluate(() => ({
                theme: document.documentElement.dataset.theme,
                links: [
                  ...document.querySelectorAll<HTMLLinkElement>(
                    'link[id^="openclaw-theme-palette-"]',
                  ),
                ].map((link) => ({ href: link.href, loaded: Boolean(link.sheet) })),
                accent: getComputedStyle(document.documentElement).getPropertyValue("--accent"),
                primary: getComputedStyle(document.documentElement).getPropertyValue("--primary"),
              }))
            : undefined;
          const rail = page.locator(".sidebar-rail__create .sidebar-new-session");
          const railSamples = await inspectStates(
            page,
            rail,
            `${id} rail`,
            "var(--accent-foreground)",
            [
              "var(--sidebar-rail-action-bg)",
              "var(--sidebar-rail-action-hover-bg)",
              "var(--sidebar-rail-action-active-bg)",
            ],
          );
          const chatInput = page.locator(".chat-pane-cache__pane--active .agent-chat__input");
          const textarea = chatInput.locator(".agent-chat__composer-combobox textarea");
          await textarea.fill("Review this draft.");
          const send = page.getByRole("button", { name: "Send message", exact: true });
          const desktop = await inspectStates(
            page,
            send,
            `${id} send`,
            "var(--chat-send-foreground)",
          );
          await screenshot(page, `${id}-desktop-send`, [chatInput, rail]);
          await page.setViewportSize({ width: 390, height: 844 });
          const mobile = await inspectStates(
            page,
            send,
            `${id} send`,
            "var(--chat-send-foreground)",
          );
          await screenshot(page, `${id}-mobile-send`, [chatInput]);
          if (theme === "crt" && mode === "dark") {
            // An explicit theme token must reach the SVG, not only its button.
            await page.evaluate(() =>
              document.documentElement.style.setProperty("--chat-send-foreground", "#000000"),
            );
            await inspectStates(page, send, `${id} explicit send ink`, "#000000");
            await page.evaluate(() =>
              document.documentElement.style.removeProperty("--chat-send-foreground"),
            );
          }
          const sendCount = (await gateway.getRequests("chat.send")).length;
          await send.click();
          const sent = await gateway.waitForRequest("chat.send", { after: sendCount });
          expect(sent.params, `${id}: submitted draft`).toMatchObject({
            message: "Review this draft.",
          });
          const stop = page.getByRole("button", { name: "Stop generating", exact: true });
          await stop.waitFor({ state: "visible" });
          const stopMobile = await inspectStates(page, stop, `${id} stop`, "var(--danger)");
          await screenshot(page, `${id}-mobile-stop`, [chatInput]);
          await page.setViewportSize({ width: 1440, height: 900 });
          const stopDesktop = await inspectStates(page, stop, `${id} stop`, "var(--danger)");
          const abortCount = (await gateway.getRequests("chat.abort")).length;
          await stop.click();
          await gateway.waitForRequest("chat.abort", { after: abortCount });
          await stop.waitFor({ state: "detached" });
          await evaluateControlUiContext(page, (app) => app.navigate("new-session"));
          await waitForControlUiRoute(page, { routeId: "new-session" });
          await page.setViewportSize({ width: 390, height: 844 });
          const newInput = page.locator(".new-session-page .agent-chat__input");
          await newInput.locator(".new-session-page__message").fill("A new conversation draft.");
          const start = page.locator(".new-session-page__start-submit");
          const newSession = await inspectStates(
            page,
            start,
            `${id} new session`,
            "var(--chat-send-foreground)",
          );
          await screenshot(page, `${id}-mobile-new`, [newInput]);
          if (theme === "crt" && mode === "dark") {
            await page.evaluate(() =>
              document.documentElement.style.setProperty("--chat-send-foreground", "#000000"),
            );
            await inspectStates(page, start, `${id} explicit new session ink`, "#000000");
            await page.evaluate(() =>
              document.documentElement.style.removeProperty("--chat-send-foreground"),
            );
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
        }
      },
    );
  });
});
