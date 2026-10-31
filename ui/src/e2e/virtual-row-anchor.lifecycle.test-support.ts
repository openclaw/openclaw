import type { Page } from "playwright";
import { expect } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  captureTopVisibleVirtualRow,
  expectPaintedVirtualRowAnchor,
  startVirtualRowPaintProbe,
  stopVirtualRowPaintProbe,
  type VirtualRowPaintResult,
  waitForPaintedVirtualRowAnchor,
} from "./virtual-row-anchor.test-support.ts";

export async function expectVirtualRowPaintProbeLifecycle(page: Page) {
  await page.clock.install();
  await pauseVirtualClock(page);
  await page.setContent(`
    <div id="thread" style="height: 100px; overflow: auto; width: 200px">
      <div class="chat-virtual-row" data-virtual-row-key="anchor" data-index="0"
        style="height: 20px">Reader anchor</div>
    </div>
  `);
  const thread = page.locator("#thread");
  const row = thread.locator(".chat-virtual-row");
  const anchor = await captureTopVisibleVirtualRow(thread);
  await startVirtualRowPaintProbe(thread, anchor);
  let result: VirtualRowPaintResult;
  try {
    await row.evaluate((element) => {
      element.dataset.index = "1";
      element.style.transform = "translateY(0px)";
    });
    await page.clock.runFor(100);
    await waitForPaintedVirtualRowAnchor(thread);
    // This mutation used to reopen the probe between readiness and stop.
    await row.evaluate((element) => {
      element.style.transform = "translateY(20px)";
    });
  } finally {
    result = await stopVirtualRowPaintProbe(thread);
  }
  expectPaintedVirtualRowAnchor(anchor, result);

  const shiftedAnchor = await captureTopVisibleVirtualRow(thread);
  await startVirtualRowPaintProbe(thread, shiftedAnchor);
  try {
    const finished = await row.evaluate((element) => {
      element.dataset.index = "2";
      element.style.transform = "translateY(40px)";
      const probe = (
        globalThis as typeof globalThis & {
          chatPrependPaintProbe?: { finish: () => boolean };
        }
      ).chatPrependPaintProbe;
      if (!probe) {
        throw new Error("expected an active virtual row paint probe");
      }
      // The real observer has a queued record, but no delivered callback yet.
      return probe.finish();
    });
    expect(finished).toBe(false);
    await page.clock.runFor(100);
    await waitForPaintedVirtualRowAnchor(thread);
  } finally {
    result = await stopVirtualRowPaintProbe(thread);
  }
  expect(result.pending).toBe(false);
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]?.viewportTop).toBe(shiftedAnchor.viewportTop + 20);
  expect(() => expectPaintedVirtualRowAnchor(shiftedAnchor, result)).toThrow();
}
