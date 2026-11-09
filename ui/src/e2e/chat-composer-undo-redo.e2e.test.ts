// Composer native undo/redo regression: the controlled `.value` binding must
// not re-apply the textarea value after native input, which clobbers the
// browser's undo/redo bookkeeping (#131708).
import type { Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat composer native undo/redo",
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

const COMPOSER_TEXTAREA = ".agent-chat__composer-combobox > textarea";
const TYPED_TEXT = "hello world test";

let page: Page;

suite.define(() => {
  beforeAll(async () => {
    const context = await suite.newBrowserContext({});
    page = await context.newPage();
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator(COMPOSER_TEXTAREA).waitFor({ timeout: 30_000 });
  });

  it("keeps native redo working after undo in the composer textarea", async () => {
    const textarea = page.locator(COMPOSER_TEXTAREA);
    await textarea.click();
    await textarea.type(TYPED_TEXT);
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    expect(await textarea.inputValue()).toBe("");

    await page.keyboard.press("ControlOrMeta+z");
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);

    // Redo must re-apply the deletion, exactly like a native textarea.
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await textarea.inputValue()).toBe("");
  });

  it("shrinks a capped draft when removing its scrollbar allows fewer wrapped lines", async () => {
    const textarea = page.locator(COMPOSER_TEXTAREA);
    const style = await page.addStyleTag({
      content: `
        ${COMPOSER_TEXTAREA} {
          width: 200px;
          min-height: 20px;
          max-height: 75px;
          padding: 0;
          border: 0;
          font: 16px/20px monospace;
          scrollbar-gutter: auto;
          scrollbar-width: auto;
          scrollbar-color: auto;
        }
        ${COMPOSER_TEXTAREA}::-webkit-scrollbar { width: 30px; }
      `,
    });
    try {
      await textarea.fill("x".repeat(150));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(
        await textarea.evaluate((element: HTMLTextAreaElement) => ({
          width: element.offsetWidth,
          contentWidth: element.clientWidth,
          height: element.clientHeight,
        })),
      ).toEqual({ width: 200, contentWidth: 170, height: 75 });

      await textarea.fill("x".repeat(60));
      expect(
        await textarea.evaluate((element: HTMLTextAreaElement) => ({
          contentWidth: element.clientWidth,
          height: element.clientHeight,
          contentHeight: element.scrollHeight,
        })),
      ).toEqual({ contentWidth: 200, height: 60, contentHeight: 60 });
    } finally {
      await style.evaluate((element) => {
        element.parentNode?.removeChild(element);
      });
      await textarea.fill("");
    }
  });
});
