import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer text readability" });

suite.define(() => {
  it.each([
    { route: "chat", width: 1280 },
    { route: "new", width: 1280 },
    { route: "chat", width: 390 },
    { route: "new", width: 390 },
  ])("keeps overflowing $route text readable at $width px", async ({ route, width }) => {
    await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}${route}`);
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      const mask = () => textarea.evaluate((el) => getComputedStyle(el).maskImage);
      const expectEditing = async (key?: string) => expect(await mask(), key).toBe("none");
      const pressEditing = async (...keys: string[]) => {
        for (const key of keys) {
          await textarea.press(key);
          await expectEditing(key);
        }
      };
      const overflow = () => textarea.evaluate((el) => getComputedStyle(el).overflowY);
      const scrollTop = () => textarea.evaluate((el) => el.scrollTop);
      const mac = process.platform === "darwin";
      const lines = Array.from(
        { length: 40 },
        (_, index) => `Line ${index + 1}: Keep text readable`,
      );
      await textarea.fill(lines.slice(0, 2).join("\n"));
      // Grow through the height cap using native editing, without forcing scrollTop.
      for (const line of lines.slice(2)) {
        await textarea.press("Shift+Enter");
        await page.keyboard.insertText(line);
        await expectEditing();
      }
      await expect.poll(() => textarea.inputValue()).toBe(lines.join("\n"));
      await expect.poll(scrollTop).toBeGreaterThan(0);
      await expectEditing();
      expect(await overflow()).not.toBe("hidden");

      // Moving the caret must preserve editing protection after every key.
      await pressEditing(
        "ArrowLeft",
        "ArrowRight",
        mac ? "Alt+ArrowLeft" : "Control+ArrowLeft",
        mac ? "Alt+ArrowRight" : "Control+ArrowRight",
        "Shift+ArrowLeft",
        "ArrowRight",
        mac ? "Meta+ArrowLeft" : "Home",
        mac ? "Meta+ArrowRight" : "End",
        "ArrowDown",
      );

      const typingScrollTop = await scrollTop();
      await textarea.hover();
      await page.mouse.wheel(0, -80);
      await expect.poll(scrollTop).toBeLessThan(typingScrollTop);
      await expect.poll(mask).not.toBe("none");
      // Keyboard navigation must also enter editing protection after pointer browsing.
      await pressEditing("ArrowLeft");
      await page.mouse.wheel(0, -80);
      await expect.poll(mask).not.toBe("none");
      // Typing after browsing still clears the fade before native caret scrolling.
      await textarea.press("y");
      await expect.poll(mask).toBe("none");

      await textarea.press(mac ? "Meta+ArrowUp" : "Control+Home");
      await expect
        .poll(() =>
          textarea.evaluate((el) => ({
            caret: (el as HTMLTextAreaElement).selectionStart,
            firstLineVisible: el.scrollTop < Number.parseFloat(getComputedStyle(el).lineHeight),
          })),
        )
        .toEqual({ caret: 0, firstLineVisible: true });
      await expectEditing();
      await pressEditing("ArrowDown", "PageDown", "PageUp", "x");
      await textarea.press(mac ? "Meta+ArrowDown" : "Control+End");
      await textarea.press("Shift+Enter");
      await pressEditing("x");
      await expect.poll(scrollTop).toBeGreaterThan(0);

      await textarea.fill("Short draft");
      await expect.poll(overflow).toBe("hidden");
      await expectEditing();
    });
  });
});
