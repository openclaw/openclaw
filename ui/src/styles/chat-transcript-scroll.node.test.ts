import { existsSync } from "node:fs";
import { chromium, firefox } from "playwright";
import { describe, expect, it } from "vitest";
import { readStyles, styleDocument } from "./style-fixture.test-support.ts";

const css = readStyles(
  "styles/chat/startup-layout",
  "styles/chat/layout",
  "styles/chat/composer-surface",
  "styles/chat/message-layout",
);

const widthCaps: { value: string; width?: (available: number, inset: number) => number }[] = [
  { value: "48rem", width: (available, inset) => Math.min(768, available - 2 * inset) },
  { value: "50%", width: (available) => available / 2 },
  { value: "calc(50% + 10px)", width: (available) => available / 2 + 10 },
  { value: "min(50%, 600px)", width: (available) => Math.min(available / 2, 600) },
  { value: "none", width: (available, inset) => available - 2 * inset },
  { value: "min-content" },
  { value: "max-content" },
];

for (const browserType of [chromium, firefox]) {
  describe.runIf(existsSync(browserType.executablePath()))(browserType.name(), () => {
    it("keeps the transcript tail above the overlapping composer without moving the Details gutter", async () => {
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
        for (const [width, height, contentHeight, reserve] of [
          [1200, 1000, 891, 300],
          [1200, 714, 2400, 0],
          [480, 300, 900, 0],
        ]) {
          await page.setContent(
            styleDocument(
              `* { box-sizing: border-box; } :root { --openclaw-corner-radius-scale: 1; }
              @property --chat-thread-inline-inset { syntax: "<length>"; inherits: true; initial-value: 0px; } ${css}`,
              `<main class="sidebar-region--desktop" style="width:${width}px;height:${height}px;--chat-details-space:${reserve}px">
              <div class="chat"><div class="chat-main__conversation-frame"><div class="chat-main__conversation">
                <div class="chat-thread-viewport"><div class="chat-thread" data-position-rail-gutter>
                  <div class="chat-position-rail" data-overflow></div>
                  <div class="chat-thread-content"><div class="chat-thread-inner chat-thread-inner--virtual" style="height:${contentHeight}px">
                    <div class="chat-virtual-block" style="height:${contentHeight}px">
                      <button style="position:absolute;bottom:12px;height:24px">Copy last reply</button>
                    </div>
                  </div></div>
                </div></div>
                <div class="chat-footer" style="height:146px"><div class="agent-chat__composer-shell">Composer</div></div>
              </div></div></div>
            </main>`,
            ),
          );
          for (const cap of widthCaps) {
            await page
              .locator(".chat")
              .evaluate(
                (element, value) => element.style.setProperty("--chat-thread-max-width", value),
                cap.value,
              );
            const boxes = await page.evaluate(() => {
              const thread = document.querySelector<HTMLElement>(".chat-thread")!;
              // Match the layout owner committing the slot size without changing CSS padding.
              thread.style.width = `${thread.parentElement!.getBoundingClientRect().width}px`;
              thread.style.height = `${thread.parentElement!.getBoundingClientRect().height}px`;
              thread.scrollTop = 1e8;
              const bounds = (selector: string) => {
                const { left, right, top, bottom } = document
                  .querySelector(selector)!
                  .getBoundingClientRect();
                return { left, right, top, bottom };
              };
              return {
                thread: bounds(".chat-thread"),
                frame: bounds(".chat-main__conversation-frame"),
                column: bounds(".chat-thread-inner"),
                conversation: bounds(".chat-main__conversation"),
                tail: bounds("button"),
                composer: bounds(".chat-footer"),
                padding: Number.parseFloat(getComputedStyle(thread).paddingBottom),
                scrollTop: thread.scrollTop,
                horizontalOverflow: thread.scrollWidth - thread.clientWidth,
                available:
                  thread.clientWidth -
                  Number.parseFloat(
                    getComputedStyle(thread).getPropertyValue("--chat-details-space"),
                  ),
                inset: Number.parseFloat(
                  getComputedStyle(thread).getPropertyValue("--chat-thread-inline-inset"),
                ),
                columnWidth: document.querySelector(".chat-thread-inner")!.getBoundingClientRect()
                  .width,
              };
            });
            expect(boxes.scrollTop).toBeGreaterThan(0);
            expect(boxes.composer.top - boxes.tail.bottom).toBeGreaterThanOrEqual(4);
            expect(boxes.thread.bottom - boxes.column.bottom).toBeCloseTo(boxes.padding, 0);
            expect(boxes.thread.right).toBeCloseTo(boxes.frame.right, 0);
            expect((boxes.column.left + boxes.column.right) / 2).toBeCloseTo(
              (boxes.conversation.left + boxes.conversation.right) / 2,
              0,
            );
            expect(boxes.horizontalOverflow).toBe(0);
            if (cap.width) {
              expect(boxes.columnWidth, cap.value).toBeCloseTo(
                cap.width(boxes.available, boxes.inset),
                0,
              );
            }
          }
        }
      } finally {
        await browser.close();
      }
    });
  });
}
