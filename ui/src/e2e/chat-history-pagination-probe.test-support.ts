import type { Locator } from "playwright";

type HistoryPaginationSample = {
  marks: {
    armed: number;
    position?: number;
    request?: number;
    response?: number;
    requestFailed?: number;
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
  targetSessionKey: string,
) {
  await paneLocator.evaluate(
    (element, { count, sessionKey }) => {
      const pane = element as HTMLElement & {
        state: { chatMessages: unknown[] };
        loadingOlder: boolean;
        requestUpdate: (...args: unknown[]) => void;
        updateComplete: Promise<boolean>;
      };
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        context: {
          gateway: { snapshot: { client: { request: (...args: unknown[]) => Promise<unknown> } } };
        };
      };
      const client = app.context.gateway.snapshot.client;
      const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
      const sample: HistoryPaginationSample = {
        marks: { armed: performance.now() },
        frames: [],
        longTasks: [],
        rows: 0,
        markers: 0,
        lateChanges: 0,
      };
      let finish: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let lastActivity = performance.now();
      let confirmed = false;
      let stableFrames = 0;
      const changed = () => {
        lastActivity = performance.now();
        stableFrames = 0;
        if (confirmed) {
          sample.lateChanges += 1;
        }
      };
      const mutations = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.type !== "attributes" ||
              (record.target as Element).getAttribute(record.attributeName!) !== record.oldValue,
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
      const originalRequest = client.request;
      client.request = function (...args) {
        const params = args[1] as { sessionKey?: string; offset?: number } | undefined;
        const selected =
          args[0] === "chat.history" &&
          params?.sessionKey === sessionKey &&
          (params.offset ?? 0) > 0;
        if (selected) {
          sample.marks.request ??= performance.now();
        }
        const promise = originalRequest.apply(this, args);
        if (selected) {
          void promise.then(
            () => {
              sample.marks.response = performance.now();
            },
            () => {
              sample.marks.requestFailed = performance.now();
            },
          );
        }
        return promise;
      };
      const originalUpdate = pane.requestUpdate;
      pane.requestUpdate = function (...args) {
        originalUpdate.apply(this, args);
        if (pane.state.chatMessages.length >= count && sample.marks.published === undefined) {
          sample.marks.published = performance.now();
          void pane.updateComplete.then(() => {
            sample.marks.paneUpdateComplete = performance.now();
          });
        }
      };
      const wheel = () => {
        sample.marks.wheel ??= performance.now();
      };
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
          if (sample.marks.published === undefined) {
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
        if (
          sample.marks.paneUpdateComplete !== undefined &&
          admitted &&
          sample.marks.committed === undefined
        ) {
          sample.marks.committed = now;
          changed();
        }
        const position = `${offset}:${rows.map((row) => `${row.dataset.virtualRowKey}:${row.dataset.index}`).join(",")}`;
        if (position !== prior) {
          prior = position;
          changed();
        }
        if (sample.marks.committed !== undefined && !pane.loadingOlder && !confirmed) {
          stableFrames += 1;
          if (stableFrames >= 2 && now - lastActivity >= 50) {
            sample.marks.settled = Math.max(sample.marks.committed, lastActivity);
            sample.marks.quietConfirmed = now;
            sample.rows = rows.length;
            sample.markers = thread.querySelectorAll(".chat-position-rail__marker").length;
            confirmed = true;
            finish();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      window.historyPaginationProbe = {
        begin: () => {
          sample.marks.position ??= performance.now();
        },
        done,
        result: () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          mutations.disconnect();
          resize.disconnect();
          client.request = originalRequest;
          pane.requestUpdate = originalUpdate;
          thread.removeEventListener("wheel", wheel, true);
          thread.removeEventListener("scroll", scrolled);
          return sample;
        },
      };
    },
    { count: messageCount, sessionKey: targetSessionKey },
  );
}
