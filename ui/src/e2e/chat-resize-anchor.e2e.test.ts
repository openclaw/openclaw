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
  return page.locator(".chat-thread-inner--virtual").evaluate((inner, key) => {
    const viewport = inner.parentElement!.getBoundingClientRect();
    const visible = (rect: DOMRect | undefined) =>
      rect !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom;
    const rows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")]
      .filter((row) => visible(row.getBoundingClientRect()))
      .toSorted(
        (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
      );
    const row = key === null ? rows[0] : rows.find((item) => item.dataset.virtualRowKey === key);
    return {
      key: row?.dataset.virtualRowKey ?? null,
      topDelta: row ? row.getBoundingClientRect().top - viewport.top : Number.NaN,
      contentVisible: visible(row?.querySelector(".chat-group-messages")?.getBoundingClientRect()),
    };
  }, anchorKey);
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
  it("keeps the anchor row stable across pane width changes", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
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
    const scroller = page.locator(".chat-thread");
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(2);

    // Use native input to release the initial end anchor.
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

    // Move footer/turn gaps into message content before capturing the anchor.
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
      // Font rewrap drifts up to 63px; the regression lost the row by 250px+.
      expect(
        Math.abs(sample.topDelta - before.topDelta),
        `anchor drift at width ${width}`,
      ).toBeLessThanOrEqual(120);
    }
  }, 120_000);
});
