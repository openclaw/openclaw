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
    evaluate: async (expression: string | ((value?: number) => unknown), value?: number) =>
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
