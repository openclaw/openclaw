import type { Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { newChatPage } from "./chat-flow.test-support.ts";
import { twoFrames } from "./chat-presentation.test-support.ts";
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
    page = await newChatPage(suite, {});
    await installMockGateway(page);
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ) as PropertyDescriptor & { get(): string; set(next: string): void };
      Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
        get: descriptor.get,
        set(next: string) {
          if (this.isConnected) {
            (window as { composerValueWrites?: number }).composerValueWrites =
              ((window as { composerValueWrites?: number }).composerValueWrites ?? 0) + 1;
          }
          descriptor.set.call(this, next);
        },
        configurable: true,
      });
    });
    await page.goto(`${suite.server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator(COMPOSER_TEXTAREA).waitFor({ timeout: 30_000 });
  });

  async function valueWriteCount(): Promise<number> {
    return page.evaluate(async () => {
      const pane = document.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-chat-pane",
      );
      if (!pane) {
        throw new Error("Expected the composer chat pane");
      }
      // Wait for the draft-triggered pane render and its nested Solid composer.
      await pane.updateComplete;
      return (window as { composerValueWrites?: number }).composerValueWrites ?? 0;
    });
  }

  it("preserves native undo/redo without textarea write-back (#131708)", async () => {
    const textarea = page.locator(COMPOSER_TEXTAREA);
    await textarea.click();

    const beforeTyping = await valueWriteCount();
    await textarea.type(TYPED_TEXT);
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);
    expect((await valueWriteCount()) - beforeTyping).toBe(0);

    const beforeUndo = await valueWriteCount();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    expect(await textarea.inputValue()).toBe("");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect(await textarea.inputValue()).toBe("");
    expect((await valueWriteCount()) - beforeUndo).toBe(0);
  });

  it("shrinks a capped draft when removing its scrollbar allows fewer wrapped lines", async () => {
    const textarea = page.locator(COMPOSER_TEXTAREA);
    const measure = () =>
      textarea.evaluate((element: HTMLTextAreaElement) => ({
        width: element.offsetWidth,
        contentWidth: element.clientWidth,
        height: element.clientHeight,
        contentHeight: element.scrollHeight,
      }));
    const style = await page.addStyleTag({
      content: `
        ${COMPOSER_TEXTAREA} {
          width: 200px;
          min-height: 20px;
          max-height: 75px;
          padding: 0;
          border: 0;
          font: 16px/20px monospace;
          scrollbar-width: auto;
          scrollbar-color: auto;
        }
        ${COMPOSER_TEXTAREA}::-webkit-scrollbar { width: 30px; }
      `,
    });
    try {
      await textarea.fill("x".repeat(150));
      await twoFrames(page);
      expect(await measure()).toMatchObject({ width: 200, contentWidth: 170, height: 75 });

      await textarea.fill("x".repeat(60));
      expect(await measure()).toMatchObject({ contentWidth: 200, height: 60, contentHeight: 60 });
    } finally {
      await style.evaluate((element) => element.remove());
      await textarea.fill("");
    }
  });
});
