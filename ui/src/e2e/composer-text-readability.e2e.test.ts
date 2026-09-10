import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
    const artifactDir = createControlUiE2eArtifactDir(`composer-${route}-${width}`);
    await suite.withPage(
      { viewport: { width, height: 900 }, recordVideo: { dir: artifactDir } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        const lines = Array.from(
          { length: 20 },
          (_, index) => `Line ${index + 1}: Keep text readable`,
        );
        await textarea.fill(lines.slice(0, 2).join("\n"));
        // Grow through the height cap using native editing, without forcing scrollTop.
        for (const line of lines.slice(2)) {
          await textarea.press("Shift+Enter");
          await page.keyboard.insertText(line);
          expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        }
        await expect.poll(() => textarea.inputValue()).toBe(lines.join("\n"));
        await expect.poll(() => textarea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await page.screenshot({ path: `${artifactDir}/typing-last-line.png` });
        expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        expect(await textarea.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

        const typingScrollTop = await textarea.evaluate((el) => el.scrollTop);
        await textarea.hover();
        await page.mouse.wheel(0, -80);
        await expect
          .poll(() => textarea.evaluate((el) => el.scrollTop))
          .toBeLessThan(typingScrollTop);
        await expect
          .poll(() => textarea.evaluate((el) => getComputedStyle(el).maskImage))
          .not.toBe("none");
        await page.screenshot({ path: `${artifactDir}/scrolling-draft.png` });
        // Typing again after scrolling must clear the fade before native caret scrolling.
        await textarea.press("y");
        await expect
          .poll(() => textarea.evaluate((el) => getComputedStyle(el).maskImage))
          .toBe("none");

        await textarea.press("ControlOrMeta+Home");
        await expect
          .poll(() =>
            textarea.evaluate((el) => ({
              caret: (el as HTMLTextAreaElement).selectionStart,
              firstLineVisible: el.scrollTop < Number.parseFloat(getComputedStyle(el).lineHeight),
            })),
          )
          .toEqual({ caret: 0, firstLineVisible: true });
        expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");
        await textarea.press("ArrowDown");
        await textarea.press("x");
        expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        await textarea.press("ControlOrMeta+End");
        await textarea.press("Shift+Enter");
        await textarea.press("x");
        expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        await expect.poll(() => textarea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

        await textarea.fill("Short draft");
        await expect
          .poll(() => textarea.evaluate((el) => getComputedStyle(el).overflowY))
          .toBe("hidden");
        expect(await textarea.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
      },
    );
  });
});
