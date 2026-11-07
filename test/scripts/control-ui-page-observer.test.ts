// @vitest-environment jsdom
import { runInThisContext } from "node:vm";
import type { Page } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import {
  finishControlUiPageObserver,
  installControlUiPageObserver,
  readControlUiPageObserver,
  resetControlUiPageObserver,
} from "../../scripts/lib/control-ui-page-observer.ts";

class TaskObserver {
  static supportedEntryTypes = ["longtask"];
  static current: TaskObserver;
  pending: PerformanceEntry[] = [];
  constructor() {
    TaskObserver.current = this;
  }
  observe() {}
  takeRecords() {
    return this.pending.splice(0);
  }
}

function task(startTime: number, duration: number): PerformanceEntry {
  return {
    name: "self",
    entryType: "longtask",
    startTime,
    duration,
    toJSON: () => ({ startTime, duration }),
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, "openclawPageBenchmarkObserver");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("excludes measurement setup from action long tasks without moving the initial DOM census", async () => {
  vi.stubGlobal("PerformanceObserver", TaskObserver);
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  // SAFETY: This adapter runs the exact serialized browser observer and its
  // evaluate callbacks in jsdom; these are the only Page methods the API uses.
  const page = {
    addInitScript: async () => {},
    evaluate: async (expression: string | ((value?: unknown) => unknown), value?: unknown) =>
      typeof expression === "string" ? runInThisContext(expression) : expression(value),
  } as unknown as Page;
  await installControlUiPageObserver(page);
  const before = document.querySelectorAll("*").length;
  await resetControlUiPageObserver(page);
  document.body.append(document.createElement("div"));
  TaskObserver.current.pending.push(task(120, 327), task(220, 73), task(401, 90));
  clock.mockReturnValue(400);
  await finishControlUiPageObserver(page);

  expect(await readControlUiPageObserver(page, 200)).toMatchObject({
    startedAt: 200,
    endedAt: 400,
    durationMs: 200,
    longTaskCount: 1,
    longTaskTotalMs: 73,
    longestLongTaskMs: 73,
    elementsBefore: before,
    elementsAfter: before + 1,
  });
  expect(await readControlUiPageObserver(page)).toMatchObject({
    startedAt: 100,
    longTaskCount: 2,
    longestLongTaskMs: 327,
  });
  document.body.lastElementChild?.remove();
});

it("counts only interval assets completed by route readiness and retains the later waterfall", async () => {
  vi.stubGlobal("PerformanceObserver", TaskObserver);
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const resource = (name: string, startTime: number, responseEnd: number) => ({
    name: `http://127.0.0.1/assets/${name}`,
    entryType: "resource",
    startTime,
    duration: responseEnd - startTime,
    toJSON: () => ({ name, startTime, responseEnd }),
    requestStart: startTime + 1,
    responseStart: responseEnd - 1,
    responseEnd,
    nextHopProtocol: "http/1.1",
    encodedBodySize: 10,
    transferSize: 310,
  });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    resource("preloaded.js", 180, 240),
    ...Array.from({ length: 7 }, (_, index) => resource(`${index}.js`, 210 + index, 260)),
    resource("late.css", 230, 340),
    resource("image.png", 240, 270),
    resource("after.js", 420, 450),
  ]);
  // SAFETY: Execute the serialized observer and its evaluate callbacks in this test realm.
  const page = {
    addInitScript: async () => {},
    evaluate: async (expression: string | ((value?: unknown) => unknown), value?: unknown) =>
      typeof expression === "string" ? runInThisContext(expression) : expression(value),
  } as unknown as Page;
  await installControlUiPageObserver(page);
  await resetControlUiPageObserver(page);
  // A navigation task begins before its own browser-local asset timestamp.
  TaskObserver.current.pending.push(task(150, 100));
  clock.mockReturnValue(400);
  await finishControlUiPageObserver(page);

  const observation = await readControlUiPageObserver(page, 100, 300, 200);
  expect(observation).toMatchObject({
    longTaskCount: 1,
    longestLongTaskMs: 100,
    assetRequests: 8,
    assetRequestsCompletedByReady: 7,
    assetEncodedBytesCompletedByReady: 70,
    http1AssetConnectionWavesByReady: 2,
  });
  expect(observation.assets.at(-1)).toEqual({
    name: "/assets/late.css",
    startMs: 30,
    requestMs: 31,
    responseMs: 139,
    endMs: 140,
    protocol: "http/1.1",
    encodedBodyBytes: 10,
    transferBytes: 310,
    completedByReady: false,
  });
});

it("retains a shifted text node's row identity after virtualization removes it", async () => {
  let deliver: ((entries: unknown[]) => void) | undefined;
  class LayoutObserver extends TaskObserver {
    static supportedEntryTypes = ["layout-shift"];
    constructor(callback: (list: { getEntries(): unknown[] }) => void) {
      super();
      deliver = (entries) => callback({ getEntries: () => entries });
    }
  }
  vi.stubGlobal("PerformanceObserver", LayoutObserver);
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  // SAFETY: Run the serialized browser observer and its callbacks in this DOM realm.
  const page = {
    addInitScript: async () => {},
    evaluate: async (expression: string | ((value?: unknown) => unknown), value?: unknown) =>
      typeof expression === "string" ? runInThisContext(expression) : expression(value),
  } as unknown as Page;
  await installControlUiPageObserver(page);
  await resetControlUiPageObserver(page);
  const row = document.createElement("div");
  row.dataset.virtualRowKey = "synthetic-row";
  row.className = "chat-virtual-row";
  const paragraph = document.createElement("p");
  paragraph.textContent = "Synthetic reply";
  row.append(paragraph);
  document.body.append(row);
  deliver!([
    {
      startTime: 150,
      value: 0.01,
      hadRecentInput: false,
      sources: [
        {
          node: paragraph.firstChild,
          previousRect: new DOMRect(10, 20, 100, 18),
          currentRect: new DOMRect(10, 41, 100, 18),
        },
      ],
    },
  ]);
  row.remove();
  paragraph.remove();
  clock.mockReturnValue(200);
  await finishControlUiPageObserver(page);
  const result = await readControlUiPageObserver(page);
  expect(result.cls).toBe(0.01);
  expect(result.layoutShiftSources[0]?.nodes[0]).toMatchObject({
    tag: "#text",
    rowKey: "synthetic-row",
    ancestors: ["p.", "div.chat-virtual-row", "body.", "html."],
    before: [10, 20, 100, 18],
    after: [10, 41, 100, 18],
  });
});
