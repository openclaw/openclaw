// Regression: resizing the chat pane must not jump the transcript. The reader's
// anchor row (topmost visible row) should stay in place while rows re-wrap.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat transcript resize anchoring",
  startServerBeforeBrowser: true,
  setupTimeoutMs: 120_000,
  trackBrowserContexts: true,
});

const MESSAGE_COUNT = 120;
const filler =
  "The quick brown fox jumps over the lazy dog while the virtualized transcript keeps every " +
  "row height honest across pane widths. ";

async function sampleAnchor(page: Page, anchorKey: string | null) {
  return await page.evaluate((key) => {
    const inner = document.querySelector<HTMLElement>(".chat-thread-inner--virtual");
    const scroller = inner?.parentElement;
    if (!inner || !scroller) {
      return { key: null, topDelta: Number.NaN, contentVisible: false };
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")]
      .map((row) => ({
        key: row.dataset.virtualRowKey ?? "",
        rect: row.getBoundingClientRect(),
        contentRect: row.querySelector(".chat-group-messages")?.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom)
      .toSorted((left, right) => left.rect.top - right.rect.top);
    const anchor = key === null ? rows[0] : rows.find((row) => row.key === key);
    return {
      key: anchor?.key ?? null,
      topDelta: anchor ? anchor.rect.top - scrollerRect.top : Number.NaN,
      contentVisible:
        anchor?.contentRect !== undefined &&
        anchor.contentRect.bottom > scrollerRect.top &&
        anchor.contentRect.top < scrollerRect.bottom,
    };
  }, anchorKey);
}

function distanceFromEnd(page: Page) {
  return page
    .locator(".chat-thread-inner--virtual")
    .locator("..")
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function settleFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let frame = 0; frame < count; frame++) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
  }, frames);
}

suite.define(() => {
  async function openTranscript() {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      sessionKey: "agent:main:main",
      historyMessages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        // Unequal paragraph counts make rewrap change row heights non-uniformly.
        content: `Message number ${index}: ${filler.repeat((index % 4) + 1)}`,
        timestamp: now - (MESSAGE_COUNT - index) * 60_000,
      })),
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page
      .getByText(`Message number ${MESSAGE_COUNT - 1}:`)
      .first()
      .waitFor({ timeout: 15_000 });
    return page;
  }

  it("keeps the anchor row stable across pane width changes", async () => {
    const page = await openTranscript();
    const scroller = page.locator(".chat-thread");
    await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(2);

    // Native reader input interrupts initial end anchoring; assigning scrollTop
    // alone can race that owner and leave this case pinned to the latest message.
    const readingDelta = await scroller.evaluate((element) =>
      Math.floor((element.scrollHeight - element.clientHeight) / 2),
    );
    await scroller.hover();
    await page.mouse.wheel(0, -readingDelta);
    await settleFrames(page, 30);
    const readingPosition = await scroller.evaluate((element) => ({
      top: element.scrollTop,
      endDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
      height: element.clientHeight,
    }));
    expect(readingPosition.top).toBeGreaterThan(readingPosition.height);
    expect(readingPosition.endDistance).toBeGreaterThan(readingPosition.height);

    // The midpoint may land in a footer/turn gap. Put the fold inside actual
    // message content before testing whether resize preserves the reader anchor.
    if (!(await sampleAnchor(page, null)).contentVisible) {
      const contentDelta = await scroller.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find(
          (candidate) => candidate.getBoundingClientRect().bottom > top,
        );
        const content = row?.querySelector(".chat-group-messages");
        if (!content) {
          throw new Error("Reader anchor has no message content");
        }
        const bounds = content.getBoundingClientRect();
        return bounds.top + Math.min(40, bounds.height / 2) - top;
      });
      await page.mouse.wheel(0, contentDelta);
      await settleFrames(page, 30);
    }

    const before = await sampleAnchor(page, null);
    expect(before.key).not.toBeNull();
    expect(before.contentVisible, "reader anchor contains visible message content").toBe(true);

    for (const width of [1000, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await settleFrames(page, 30);
      const sample = await sampleAnchor(page, before.key);
      expect(sample.key, `anchor visible at width ${width}`).toBe(before.key);
      // Rewrap shifts the row top by up to 63px across fonts; the regression
      // lost the row entirely with 250px+ drift, leaving margin at 120px.
      expect(
        Math.abs(sample.topDelta - before.topDelta),
        `anchor drift at width ${width}`,
      ).toBeLessThanOrEqual(120);
    }
  }, 120_000);

  it("keeps an end-pinned transcript pinned across width-only resizes", async () => {
    const page = await openTranscript();
    // Fresh sessions open pinned to the end; leave the scroll untouched.
    await settleFrames(page, 30);

    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(2);

    // Width-only changes re-wrap every row; the end anchor must follow the
    // new total size (virtualizer wasAtEnd compensation), not drift upward.
    for (const width of [1000, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await settleFrames(page, 30);
      expect(
        await distanceFromEnd(page),
        `distance from end at width ${width}`,
      ).toBeLessThanOrEqual(2);
      await page
        .getByText(`Message number ${MESSAGE_COUNT - 1}:`)
        .first()
        .waitFor({ state: "visible", timeout: 2_000 });
    }
  }, 120_000);
});
