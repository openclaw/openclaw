import type { BrowserContextOptions } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat Markdown alignment",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function withMarkdown(
  text: string,
  run: Parameters<typeof suite.withPage>[1],
  options: BrowserContextOptions = {},
) {
  return suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      colorScheme: "light",
      viewport: { height: 800, width: 1180 },
      ...options,
    },
    async (fixture) => {
      await installMockGateway(fixture.page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
        ],
      });
      await fixture.page.goto(`${suite.server.baseUrl}chat`);
      return run(fixture);
    },
  );
}

function expectMarkerGeometry(geometry: ReturnType<typeof readMarkdownGeometry>) {
  const starts = geometry.textStarts;
  expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(1);
  expect(geometry.checkboxGap).toBeGreaterThanOrEqual(7);
  expect(geometry.checkboxGap).toBeLessThanOrEqual(9);
  expect(Math.abs(geometry.detailsX - geometry.rootX)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.detailsRight - geometry.rootRight)).toBeLessThanOrEqual(1);
}

function readMarkdownGeometry(root: Element) {
  const textRect = (selector: string) => {
    const element = root.querySelector(selector);
    if (!element) {
      throw new Error(`Missing element for ${selector}`);
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.trim()) {
      text = walker.nextNode();
    }
    if (!text) {
      throw new Error(`Missing text for ${selector}`);
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getBoundingClientRect();
  };
  const rtl = root.getAttribute("dir") === "rtl";
  const checkbox = root.querySelector(".task-list-item-checkbox");
  const details = root.querySelector("details[open]");
  const summary = root.querySelector("details[open] > summary");
  if (!checkbox || !details || !summary) {
    throw new Error("Missing task-list or disclosure markup");
  }
  const detailsStyle = getComputedStyle(details);
  const summaryStyle = getComputedStyle(summary);
  const checkboxRect = checkbox.getBoundingClientRect();
  const taskTextRect = textRect(".task-list-item");
  const collapsed = root.querySelector("details:not([open]) > summary");
  const collapsedSummary = collapsed ?? summary;
  if (!rtl && !collapsed) {
    throw new Error("Missing authored disclosure markup");
  }
  const closedChevronStyle = getComputedStyle(collapsedSummary, "::before");
  const collapsedSummaryTextRect = textRect(
    rtl ? "details > summary" : "details:not([open]) > summary",
  );
  return {
    textStarts: ["ul:not(.contains-task-list) > li", "ol > li", ".task-list-item"].map(
      (selector) => textRect(selector)[rtl ? "right" : "x"],
    ),
    unorderedPaddingInlineStart: getComputedStyle(
      root.querySelector("ul:not(.contains-task-list)")!,
    ).paddingInlineStart,
    orderedPaddingInlineStart: getComputedStyle(root.querySelector("ol")!).paddingInlineStart,
    summaryPaddingInlineStart: summaryStyle.paddingInlineStart,
    summaryTextRight: textRect("details > summary").right,
    bodyTextX: textRect("details > p").x,
    summaryTextX: textRect("details[open] > summary").x,
    collapsedHeight: collapsedSummary.getBoundingClientRect().height,
    collapsedLineHeight: getComputedStyle(collapsedSummary).lineHeight,
    dimensions: {
      checkboxSize: checkboxRect.width,
      border: Number.parseFloat(detailsStyle.borderInlineStartWidth),
      padding: Number.parseFloat(detailsStyle.paddingBlockStart),
      chevronWidth: Number.parseFloat(closedChevronStyle.width),
      chevronInset: Number.parseFloat(closedChevronStyle.insetInlineStart),
      summaryInset: collapsedSummaryTextRect.x - details.getBoundingClientRect().x,
    },
    checkboxGap: rtl ? checkboxRect.left - taskTextRect.right : taskTextRect.x - checkboxRect.right,
    checkboxLineCenterDelta:
      checkboxRect.y + checkboxRect.height / 2 - (taskTextRect.y + taskTextRect.height / 2),
    chevronClosedTransform: closedChevronStyle.transform,
    chevronInlineStart: closedChevronStyle.insetInlineStart,
    chevronTransitionDuration: closedChevronStyle.transitionDuration,
    chevronTransitionProperty: closedChevronStyle.transitionProperty,
    collapsedSummaryPaddingInlineStart: getComputedStyle(collapsedSummary).paddingInlineStart,
    detailsRight: details.getBoundingClientRect().right,
    detailsX: details.getBoundingClientRect().x,
    rootRight: root.getBoundingClientRect().right,
    rootX: root.getBoundingClientRect().x,
    summaryMarginBottom: summaryStyle.marginBottom,
  };
}

suite.define(() => {
  it.each([
    { name: "desktop light", colorScheme: "light", width: 1180, reducedMotion: "no-preference" },
    { name: "phone dark", colorScheme: "dark", width: 400, reducedMotion: "reduce" },
  ] as const)(
    "keeps disclosures compact and borderless on $name",
    async ({ colorScheme, width, reducedMotion }) => {
      await withMarkdown(
        '## Alignment check\n\nこれは**（注記）**です\n\nsafe<br>break and unsafe<br class="wide">markup\n\n- Bullet item\n\n1. Numbered item\n\n- [ ] Unchecked task\n\n<details open>\n<summary>More details</summary>\n\nDisclosure body\n</details>\n\n<details>\n<summary>Collapsed details</summary>\nHidden body\n</details>',
        async ({ page }) => {
          const markdown = page.locator(".chat-group.assistant .chat-text", {
            hasText: "Alignment check",
          });
          await markdown.waitFor();
          expect(await markdown.locator("strong", { hasText: "（注記）" }).count()).toBe(1);
          expect(await markdown.locator("br").count()).toBe(1);
          expect(await markdown.textContent()).toContain('unsafe<br class="wide">markup');

          const geometry = await markdown.evaluate(readMarkdownGeometry);

          expectMarkerGeometry(geometry);
          expect(Math.abs(geometry.checkboxLineCenterDelta)).toBeLessThanOrEqual(1);

          expect(geometry.bodyTextX).toBeGreaterThan(geometry.detailsX);
          expect(geometry.dimensions).toEqual({
            checkboxSize: 16,
            border: 0,
            padding: 0,
            chevronWidth: 16,
            chevronInset: 0,
            summaryInset: 24,
          });
          expect(Math.abs(geometry.bodyTextX - geometry.summaryTextX)).toBeLessThanOrEqual(1);
          expect(geometry.collapsedHeight).toBe(
            Number.parseFloat(geometry.collapsedLineHeight) + 12,
          );
          expect(Number.parseFloat(geometry.summaryMarginBottom)).toBeGreaterThan(0);
          expect(
            Number.parseFloat(geometry.collapsedSummaryPaddingInlineStart),
          ).toBeGreaterThanOrEqual(24);
          if (reducedMotion === "reduce") {
            expect(geometry.chevronTransitionProperty).toBe("none");
          } else {
            expect(geometry.chevronTransitionDuration).not.toBe("0s");
          }

          const collapsedSummary = markdown.locator("summary", { hasText: "Collapsed details" });
          await collapsedSummary.click();
          await expect
            .poll(() =>
              collapsedSummary.evaluate(
                (summary) => getComputedStyle(summary, "::before").transform,
              ),
            )
            .not.toBe(geometry.chevronClosedTransform);
          const disclosure = collapsedSummary.locator("..");
          expect(await disclosure.getAttribute("open")).not.toBeNull();
          await collapsedSummary.press("Space");
          expect(await disclosure.getAttribute("open")).toBeNull();
          await collapsedSummary.press("Enter");
          expect(await disclosure.getAttribute("open")).not.toBeNull();
          expect(
            await collapsedSummary.evaluate((summary) => getComputedStyle(summary).outlineStyle),
          ).toBe("solid");
          await collapsedSummary.hover();
          expect(
            await collapsedSummary.evaluate((summary) => getComputedStyle(summary).backgroundColor),
          ).not.toBe("rgba(0, 0, 0, 0)");
          expect(await markdown.evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(
            true,
          );
        },
        { colorScheme, reducedMotion, viewport: { height: 800, width } },
      );
    },
  );

  it("preserves inline code content and IPv6 links in assistant Markdown", async () => {
    await withMarkdown(
      "## Markdown parser fidelity\n\n`   `\n\n[foo `bar` baz`\n\n[IPv6 destination](http://[2001:db8::1]:1896/a[b]?x=[y])",
      async ({ page }) => {
        const markdown = page.locator(".chat-group.assistant .chat-text", {
          hasText: "Markdown parser fidelity",
        });
        await markdown.waitFor();

        expect(
          await markdown.evaluate((root) => ({
            code: Array.from(root.querySelectorAll("code"), (node) => node.textContent),
            paragraphs: Array.from(root.querySelectorAll("p"), (node) => node.textContent),
            links: Array.from(root.querySelectorAll("a"), (node) => node.getAttribute("href")),
          })),
        ).toEqual({
          code: ["   ", "bar"],
          paragraphs: ["   ", "[foo bar baz`", "IPv6 destination"],
          links: ["http://[2001:db8::1]:1896/a%5Bb%5D?x=%5By%5D"],
        });
      },
    );
  });

  it("preserves Markdown marker and disclosure alignment in RTL transcripts", async () => {
    await withMarkdown(
      "## فحص المحاذاة\n\n- عنصر نقطي\n\n1. عنصر مرقم\n\n- [ ] مهمة غير مكتملة\n\n<details open>\n<summary>تفاصيل إضافية</summary>\n\nمحتوى التفاصيل\n</details>",
      async ({ page }) => {
        const markdown = page.locator(".chat-group.assistant .chat-text[dir='rtl']", {
          hasText: "فحص المحاذاة",
        });
        await markdown.waitFor();

        const geometry = await markdown.evaluate(readMarkdownGeometry);

        expectMarkerGeometry(geometry);
        expect(Number.parseFloat(geometry.unorderedPaddingInlineStart)).toBe(24);
        expect(Number.parseFloat(geometry.orderedPaddingInlineStart)).toBe(24);
        expect(Number.parseFloat(geometry.chevronInlineStart)).toBe(0);
        expect(Number.parseFloat(geometry.summaryPaddingInlineStart)).toBeGreaterThanOrEqual(24);
        expect(geometry.detailsRight - geometry.summaryTextRight).toBe(24);
      },
      { locale: "ar" },
    );
  });
});
