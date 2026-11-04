import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Accent control contrast" });
const openThemedChat = createThemedChatOpener(suite);
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
        expect((high! + 0.05) / (low! + 0.05), accent + " " + state).toBeGreaterThanOrEqual(4.5);
        if (state === "active") {
          await page.mouse.up();
        }
      }
    }
  });
});
