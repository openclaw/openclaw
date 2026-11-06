import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { configProof } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Accent control contrast" });
const openThemedChat = createThemedChatOpener(suite);
const { capture } = configProof("inherited-accent-ink");
function luminance(color: RenderedColor) {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

suite.define(() => {
  it("keeps the new-session action readable through hover and press", async () => {
    const { page } = await openThemedChat("claw", "light");
    await page.goto(suite.server.baseUrl + "chat");
    const action = page.locator(".sidebar-rail__create .sidebar-new-session");
    await expect.poll(() => action.isVisible()).toBe(true);
    await page.addStyleTag({ content: "* { transition: none !important; }" });
    for (const accent of ["#707070", "#ffff00", "#080808", "#fafafa"]) {
      await page.evaluate(
        ({ key, color }) => {
          const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
          localStorage.setItem(key, JSON.stringify({ ...settings, accent: color }));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), color: accent },
      );
      await page.reload();
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
          ),
        )
        .toBe(accent);
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      const microphone = page.locator(".chat-send-btn--voice").first();
      await microphone.hover();
      const microphoneColors = await microphone.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--text-strong)";
        element.append(probe);
        const colors = {
          actual: getComputedStyle(element).color,
          expected: getComputedStyle(probe).color,
        };
        probe.remove();
        return colors;
      });
      expect(microphoneColors.actual, accent + " microphone ink").toEqual(
        microphoneColors.expected,
      );
      let restingForeground: RenderedColor | undefined;
      for (const state of ["normal", "hover", "active"]) {
        await page.mouse.move(0, 0);
        if (state !== "normal") {
          await action.hover();
        }
        if (state === "active") {
          await page.mouse.down();
        }
        const raw = await action.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, foreground: style.color };
        });
        const colors = await page.evaluate(resolveRenderedColors, raw);
        if (state === "normal") {
          restingForeground = colors.foreground;
        }
        expect(colors.foreground, `${accent} ${state} keeps resting ink`).toEqual(
          restingForeground,
        );
        const [low, high] = [luminance(colors.background!), luminance(colors.foreground!)].toSorted(
          (a, b) => a - b,
        );
        expect((high! + 0.05) / (low! + 0.05), accent + " " + state).toBeGreaterThanOrEqual(
          state === "normal" ? 3 : 4.5,
        );
        if (state === "active") {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
      await page.keyboard.press("Tab");
      await action.focus();
      const rawFocus = await action.evaluate((element) => {
        const rail = element.closest(".sidebar-rail");
        if (!rail) {
          throw new Error("Expected the primary action inside the sidebar rail");
        }
        const style = getComputedStyle(element);
        if (!element.matches(":focus-visible") || Number.parseFloat(style.outlineWidth) < 2) {
          throw new Error("Expected a visible keyboard focus outline");
        }
        return {
          foreground: style.outlineColor,
          background: style.backgroundColor,
          surface: getComputedStyle(rail).backgroundColor,
        };
      });
      const focus = await page.evaluate(resolveRenderedColors, rawFocus);
      for (const background of [focus.background!, focus.surface!]) {
        const [low, high] = [luminance(background), luminance(focus.foreground!)].toSorted(
          (a, b) => a - b,
        );
        expect((high! + 0.05) / (low! + 0.05), accent + " inset focus").toBeGreaterThanOrEqual(3);
      }
    }
  });
  it("preserves authored primary and send ink through a custom-accent reset", async () => {
    const { page } = await openThemedChat("absolutely", "dark");
    await page.goto(suite.server.baseUrl + "chat");
    for (const accent of [undefined, "#707070", "theme"]) {
      await page.evaluate(
        ({ key, accent: storedAccent }) => {
          const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
          if (storedAccent === undefined) {
            delete settings.accent;
          } else {
            settings.accent = storedAccent;
          }
          localStorage.setItem(key, JSON.stringify(settings));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), accent },
      );
      await page.reload();
      await page.locator(".agent-chat__composer-combobox textarea").fill("Authored ink");
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      const authored = accent !== "#707070";
      const root = await page.evaluate(() => ({
        primary: getComputedStyle(document.documentElement).getPropertyValue(
          "--primary-foreground",
        ),
        inlinePrimary: document.documentElement.style.getPropertyValue("--primary-foreground"),
        inlineSend: document.documentElement.style.getPropertyValue("--chat-send-foreground"),
      }));
      expect(root.inlinePrimary).toBe(authored ? "" : "#ffffff");
      expect(root.inlineSend).toBe(authored ? "" : "#ffffff");
      const expected = await page.evaluate(resolveRenderedColors, {
        primary: authored ? "#241f1b" : "#ffffff",
        send: "#ffffff",
      });
      expect(
        (await page.evaluate(resolveRenderedColors, { primary: root.primary })).primary,
      ).toEqual(expected.primary);
      const send = page.locator(".chat-send-btn--send").first();
      for (const state of ["normal", "hover", "active"]) {
        await page.mouse.move(0, 0);
        if (state !== "normal") {
          await send.hover();
        }
        if (state === "active") {
          await page.mouse.down();
        }
        const colors = await page.evaluate(
          resolveRenderedColors,
          await send.evaluate((element) => ({
            foreground: getComputedStyle(element).color,
            background: getComputedStyle(element).backgroundColor,
          })),
        );
        expect(colors.foreground, String(accent) + " " + state).toEqual(expected.send);
        const values = [luminance(colors.foreground!), luminance(colors.background!)].toSorted(
          (a, b) => a - b,
        );
        expect((values[1]! + 0.05) / (values[0]! + 0.05)).toBeGreaterThanOrEqual(
          authored && state === "normal" ? 3 : 4.5,
        );
        if (state === "active") {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
    }
  });
  it("keeps Absolutely action icons white with an inherited coral accent", async () => {
    const { page } = await openThemedChat("absolutely", "light", {
      methodResponses: {
        "config.get": configResponse(
          { theme: "absolutely", themeMode: "light", accent: "#ff8066" },
          "inherited-coral-accent",
        ),
      },
    });
    await page.goto(suite.server.baseUrl + "chat");
    const actions = [
      page.locator(".sidebar-rail__create .sidebar-new-session"),
      page.locator(".chat-send-btn--send").first(),
    ];
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        ),
      )
      .toBe("#ff8066");
    await page
      .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
      .fill("Review this draft.");
    await expect.poll(() => actions[1]!.isEnabled()).toBe(true);
    await capture(actions[0]!, "new-session.png");
    await capture(actions[1]!, "send.png");
    for (const action of actions) {
      expect(
        await action.evaluate((element) => ({
          color: getComputedStyle(element.querySelector("svg")!).color,
          background: getComputedStyle(element).backgroundColor,
        })),
      ).toEqual({ color: "rgb(255, 255, 255)", background: "rgb(230, 115, 92)" });
    }
  });
});
