// Lightweight browser test for BTW side-result scrolling behavior.
// Does not start the full Control UI dev server; it only renders the side-result
// markup with the real UI stylesheets and checks layout metrics with Playwright.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

const CSS_FILES = [
  "ui/src/styles/base.css",
  "ui/src/styles/layout.css",
  "ui/src/styles/layout.mobile.css",
  "ui/src/styles/components.css",
  "ui/src/styles/chat/layout.css",
  "ui/src/styles/chat/text.css",
  "ui/src/styles/chat/grouped.css",
  "ui/src/styles/chat/tool-cards.css",
  "ui/src/styles/chat/sidebar.css",
];

const VIEWPORTS = [
  [320, 568],
  [1366, 900],
  [1440, 900],
] as const;

function readUiCss(): string {
  return CSS_FILES.map((file) => readStyleSheet(file)).join("\n");
}

function sideResultFixture(body: string): string {
  return `
    <!doctype html>
    <html>
      <head><style>${readUiCss()}</style></head>
      <body>
        <section class="chat-side-result" role="status" aria-live="polite" aria-label="BTW side result">
          <div class="chat-side-result__header">
            <div class="chat-side-result__label-row">
              <span class="chat-side-result__label">BTW</span>
              <span class="chat-side-result__meta">Not saved to chat history</span>
            </div>
            <button class="btn chat-side-result__dismiss" type="button">Dismiss</button>
          </div>
          <div class="chat-side-result__question">What is the full answer?</div>
          <div class="chat-side-result__body" dir="ltr">${body}</div>
        </section>
      </body>
    </html>
  `;
}

describe("chat side result scroll", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it.each(VIEWPORTS)(
    "keeps long BTW results readable by scrolling at %sx%s",
    async (width, height) => {
      const longBody = Array.from(
        { length: 80 },
        (_, i) =>
          `<p>Line ${i + 1}: deliberately long filler text that makes the BTW side-result body exceed the available space so it must scroll instead of expanding forever.</p>`,
      ).join("");

      const page: Page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(sideResultFixture(longBody));

        const bodyMetrics = await page.locator(".chat-side-result__body").evaluate((node) => {
          const el = node as HTMLElement;
          const style = getComputedStyle(el);
          return {
            overflow: style.overflow,
            maxHeight: style.maxHeight,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          };
        });

        if (width <= 768) {
          // Mobile: the whole fixed card scrolls, the body itself has no independent limit.
          const cardMetrics = await page.locator(".chat-side-result").evaluate((node) => {
            const el = node as HTMLElement;
            const style = getComputedStyle(el);
            return {
              position: style.position,
              overflow: style.overflow,
              maxHeight: style.maxHeight,
              clientHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
            };
          });
          expect(cardMetrics.position).toBe("fixed");
          expect(cardMetrics.overflow).toBe("auto");
          expect(cardMetrics.clientHeight).toBeLessThan(cardMetrics.scrollHeight);
          expect(bodyMetrics.overflow).not.toBe("auto");
        } else {
          // Desktop: only the body scrolls, capped at 480px.
          expect(bodyMetrics.overflow).toBe("auto");
          expect(bodyMetrics.clientHeight).toBeLessThan(bodyMetrics.scrollHeight);
          expect(bodyMetrics.clientHeight).toBeLessThanOrEqual(480);
        }
      } finally {
        await page.close();
      }
    },
  );
});
