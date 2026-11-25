import type { Locator } from "playwright";

type AnchorFrames = { frame: number; positions: Array<number | null>; readerDelta: number };
export type AnchorWindow = typeof window & { prependFrames: AnchorFrames };

export function sampleHistoryAnchor(anchor: Locator) {
  return anchor.evaluateHandle((original) => {
    const host = original.closest("openclaw-chat-pane")!;
    const selector = `.chat-bubble[data-message-id="${CSS.escape(original.getAttribute("data-message-id")!)}"]`;
    const frames: AnchorFrames = { frame: 0, positions: [], readerDelta: 0 };
    (window as AnchorWindow).prependFrames = frames;
    const sample = () => {
      const bubble = host.querySelector(selector);
      frames.positions.push(
        bubble ? bubble.getBoundingClientRect().top + frames.readerDelta : null,
      );
      frames.frame = requestAnimationFrame(sample);
    };
    sample();
    return () => {
      cancelAnimationFrame(frames.frame);
      return frames.positions;
    };
  });
}

export function historyMessageCount(pane: Locator) {
  return pane.evaluate(
    (element: HTMLElement & { state: { chatMessages: unknown[] } }) =>
      element.state.chatMessages.length,
  );
}

type HistoryPaginationSample = {
  marks: {
    armed: number;
    position?: number;
    published?: number;
    paneUpdateComplete?: number;
    wheel?: number;
    committed?: number;
    settled?: number;
    quietConfirmed?: number;
  };
  frames: number[];
  longTasks: Array<{ startTime: number; duration: number }>;
  rows: number;
  markers: number;
  lateChanges: number;
};

declare global {
  interface Window {
    historyPaginationProbe: {
      begin: () => void;
      done: Promise<void>;
      result: () => HistoryPaginationSample;
    };
  }
}

export async function installHistoryPaginationProbe(
  paneLocator: Locator,
  messageCount: number,
  _targetSessionKey: string,
) {
  await paneLocator.evaluate((element, count) => {
    const pane = element as HTMLElement & {
      state: { chatMessages: unknown[] };
      loadingOlder: boolean;
      render: (...args: unknown[]) => unknown;
      updateComplete: Promise<boolean>;
    };
    const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
    const sample: HistoryPaginationSample = {
      marks: { armed: performance.now() },
      frames: [],
      longTasks: [],
      rows: 0,
      markers: 0,
      lateChanges: 0,
    };
    const { marks } = sample;
    const stamp = (key: keyof typeof marks) => () => {
      marks[key] = performance.now();
    };
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();
    let lastActivity = performance.now();
    let stableFrames = 0;
    const changed = () => {
      lastActivity = performance.now();
      stableFrames = 0;
      if (marks.quietConfirmed !== undefined) {
        sample.lateChanges += 1;
      }
    };
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          ({ type, target, attributeName, oldValue }) =>
            type !== "attributes" || (target as Element).getAttribute(attributeName!) !== oldValue,
        )
      ) {
        changed();
      }
    });
    mutations.observe(thread, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["style", "hidden", "data-index"],
    });
    const observed = new Set<Element>();
    const resize = new ResizeObserver(changed);
    resize.observe(thread);
    const initialIndexes = new Map<string, number>();
    let offset = thread.scrollTop;
    const scrolled = () => {
      const next = thread.scrollTop;
      if (next !== offset) {
        offset = next;
        changed();
      }
    };
    thread.addEventListener("scroll", scrolled, { passive: true });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        sample.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: "longtask" });
    const originalRender = pane.render;
    pane.render = function (...args) {
      const result = originalRender.apply(this, args);
      // Sample publication when the pane consumes the history, then fence its DOM commit.
      if (pane.state.chatMessages.length >= count && marks.published === undefined) {
        marks.published = performance.now();
        void pane.updateComplete.then(stamp("paneUpdateComplete"));
      }
      return result;
    };
    const wheel = stamp("wheel");
    thread.addEventListener("wheel", wheel, { capture: true, once: true });
    let frame = 0;
    let prior = "";
    const tick = () => {
      const now = performance.now();
      sample.frames.push(now);
      const rows = [...thread.querySelectorAll<HTMLElement>(".chat-virtual-row")];
      for (const row of rows) {
        if (!observed.has(row)) {
          observed.add(row);
          resize.observe(row);
        }
        if (marks.published === undefined) {
          initialIndexes.set(row.dataset.virtualRowKey!, Number(row.dataset.index));
        }
      }
      for (const row of observed) {
        if (!row.isConnected) {
          resize.unobserve(row);
          observed.delete(row);
        }
      }
      const admitted = rows.some((row) => {
        const index = initialIndexes.get(row.dataset.virtualRowKey!);
        return index !== undefined && Number(row.dataset.index) > index;
      });
      // The pane can publish all data while deliberately retaining the old row model during scrolling.
      if (marks.paneUpdateComplete !== undefined && admitted && marks.committed === undefined) {
        marks.committed = now;
        changed();
      }
      const position = `${offset}:${rows.map((row) => `${row.dataset.virtualRowKey}:${row.dataset.index}`).join(",")}`;
      if (position !== prior) {
        prior = position;
        changed();
      }
      if (
        marks.committed !== undefined &&
        !pane.loadingOlder &&
        marks.quietConfirmed === undefined
      ) {
        stableFrames += 1;
        if (stableFrames >= 2 && now - lastActivity >= 50) {
          marks.settled = Math.max(marks.committed, lastActivity);
          marks.quietConfirmed = now;
          sample.rows = rows.length;
          sample.markers = thread.querySelectorAll(".chat-position-rail__marker").length;
          finish();
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.historyPaginationProbe = {
      begin: () => (marks.position ??= performance.now()),
      done,
      result: () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        mutations.disconnect();
        resize.disconnect();
        pane.render = originalRender;
        thread.removeEventListener("wheel", wheel, true);
        thread.removeEventListener("scroll", scrolled);
        return sample;
      },
    };
  }, messageCount);
}
