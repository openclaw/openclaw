import type { Locator } from "playwright";
import { expect } from "vitest";

type VisibleVirtualRow = {
  index: number;
  key: string;
  totalSize: number;
  viewportTop: number;
};

type VirtualRowPaintSample = {
  index: number | null;
  intersectsViewport: boolean;
  totalSize: number;
  viewportTop: number | null;
};

type VirtualRowPaintProbe = {
  finish: () => boolean;
  stop: () => { pending: boolean; samples: VirtualRowPaintSample[] };
};
type PaintGlobal = typeof globalThis & { chatPrependPaintProbe?: VirtualRowPaintProbe };
export type VirtualRowPaintResult = ReturnType<VirtualRowPaintProbe["stop"]>;

export async function captureTopVisibleVirtualRow(thread: Locator): Promise<VisibleVirtualRow> {
  return thread.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
    ).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const index = Number.parseInt(row?.dataset.index ?? "", 10);
    if (!row || !Number.isFinite(index)) {
      throw new Error("expected a visible virtual transcript row with a valid index");
    }
    return {
      index,
      key: row.dataset.virtualRowKey ?? "",
      totalSize: element.scrollHeight,
      viewportTop: row.getBoundingClientRect().top - viewport.top,
    };
  });
}

export async function startVirtualRowPaintProbe(thread: Locator, anchor: VisibleVirtualRow) {
  await thread.evaluate((element, expected) => {
    const target = globalThis as PaintGlobal;
    target.chatPrependPaintProbe?.stop();
    const samples: VirtualRowPaintSample[] = [];
    const frames = new Set<number>();
    const timers = new Set<number>();
    let pendingSamples = 0;
    const sample = () => {
      const viewport = element.getBoundingClientRect();
      const row = Array.from(
        element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
      ).find((candidate) => candidate.dataset.virtualRowKey === expected.key);
      const rect = row?.getBoundingClientRect();
      const index = row ? Number.parseInt(row.dataset.index ?? "", 10) : Number.NaN;
      samples.push({
        index: Number.isFinite(index) ? index : null,
        intersectsViewport: Boolean(
          rect && rect.bottom > viewport.top && rect.top < viewport.bottom,
        ),
        totalSize: element.scrollHeight,
        viewportTop: rect ? rect.top - viewport.top : null,
      });
    };
    const schedule = (run: () => void, framesLeft = 2): void => {
      const ids = framesLeft ? frames : timers;
      const callback = () => {
        ids.delete(id);
        return framesLeft ? schedule(run, framesLeft - 1) : run();
      };
      const id = framesLeft ? requestAnimationFrame(callback) : window.setTimeout(callback, 0);
      ids.add(id);
    };
    const scheduleSample = () => {
      // Each mutation keeps its own two-frame + timer sample; never coalesce jumps.
      pendingSamples += 1;
      schedule(() => {
        sample();
        pendingSamples -= 1;
      });
    };
    const observer = new MutationObserver(scheduleSample);
    observer.observe(element, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    target.chatPrependPaintProbe = {
      finish() {
        // Drain queued mutations, then seal atomically after every admitted sample.
        if (observer.takeRecords().length) {
          scheduleSample();
        }
        const advanced = samples.some(
          (entry) =>
            (entry.index !== null && entry.index > expected.index) ||
            entry.totalSize > expected.totalSize,
        );
        if (pendingSamples > 0 || !advanced) {
          return false;
        }
        observer.disconnect();
        return true;
      },
      stop() {
        observer.disconnect();
        frames.forEach((id) => cancelAnimationFrame(id));
        timers.forEach((id) => clearTimeout(id));
        delete target.chatPrependPaintProbe;
        return { pending: pendingSamples > 0, samples };
      },
    };
  }, anchor);
}

function accessProbe(thread: Locator, action: "finish"): Promise<boolean>;
function accessProbe(thread: Locator, action: "stop"): Promise<VirtualRowPaintResult>;
function accessProbe(thread: Locator, action: "finish" | "stop") {
  return thread.evaluate((_element, operation) => {
    const probe = (globalThis as PaintGlobal).chatPrependPaintProbe;
    if (!probe) {
      throw new Error("expected an active virtual row paint probe");
    }
    return probe[operation]();
  }, action);
}

export async function waitForPaintedVirtualRowAnchor(thread: Locator) {
  await expect.poll(() => accessProbe(thread, "finish")).toBe(true);
}

export function stopVirtualRowPaintProbe(thread: Locator) {
  return accessProbe(thread, "stop");
}

export function expectPaintedVirtualRowAnchor(
  anchor: VisibleVirtualRow,
  result: VirtualRowPaintResult,
) {
  const evidence = JSON.stringify({ anchor, ...result });
  expect(result.pending, evidence).toBe(false);
  expect(result.samples.length, evidence).toBeGreaterThan(0);
  const advanced = result.samples.some(
    (sample) =>
      (sample.index !== null && sample.index > anchor.index) || sample.totalSize > anchor.totalSize,
  );
  expect(advanced, evidence).toBe(true);
  for (const sample of result.samples) {
    expect(sample.intersectsViewport, evidence).toBe(true);
    // Null means the anchor disappeared; Infinity makes that fail the same bound.
    const offset = Math.abs((sample.viewportTop ?? Infinity) - anchor.viewportTop);
    expect(offset, evidence).toBeLessThanOrEqual(2);
  }
}
