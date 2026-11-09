// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installControlUiMediaObserver } from "../../scripts/lib/control-ui-media-observer.ts";

class LayoutObserver implements PerformanceObserver {
  static supportedEntryTypes = ["layout-shift"];
  static current: LayoutObserver | undefined;
  pending: PerformanceEntry[] = [];

  constructor(private readonly callback: PerformanceObserverCallback) {
    LayoutObserver.current = this;
  }

  observe() {}
  disconnect() {}
  takeRecords() {
    return this.pending.splice(0);
  }
  deliver(entries: PerformanceEntry[]) {
    this.callback(
      {
        getEntries: () => entries,
        getEntriesByName: () => [],
        getEntriesByType: () => [],
      },
      this,
    );
  }
}

function shift(startTime: number, value: number, media = false, hadRecentInput = false) {
  const node = document.createElement("div");
  if (media) {
    node.append(document.createElement("img"));
  }
  return {
    name: "layout-shift",
    entryType: "layout-shift",
    duration: 0,
    startTime,
    value,
    hadRecentInput,
    sources: [
      {
        node,
        previousRect: new DOMRectReadOnly(0, 0, 20, 20),
        currentRect: new DOMRectReadOnly(0, 10, 20, 20),
      },
    ],
    toJSON: () => ({ startTime, value }),
  };
}

beforeEach(() => {
  LayoutObserver.current = undefined;
  LayoutObserver.supportedEntryTypes = ["layout-shift"];
  vi.stubGlobal("PerformanceObserver", LayoutObserver);
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL() {
        return "blob:media-fixture";
      }
      static override revokeObjectURL() {}
    },
  );
});

afterEach(() => {
  Reflect.deleteProperty(window, "controlUiMediaBench");
  vi.unstubAllGlobals();
});

it("reports cumulative sums separately from session windows through the installed read/reset API", () => {
  installControlUiMediaObserver();
  const api = window.controlUiMediaBench;
  const observer = LayoutObserver.current!;
  expect(api.read()).toMatchObject({
    layoutShiftSum: 0,
    mediaAttributedShiftSum: 0,
    maxSessionWindowShift: 0,
    shifts: [],
  });
  observer.pending = [
    shift(100, 0.1, true),
    shift(1_000, 0.2),
    shift(1_900, 0.3, true),
    shift(2_800, 0.4),
    shift(3_700, 0.5),
    shift(4_600, 0.6, true),
    shift(5_100, 0.7),
    shift(6_000, 0.8, true),
    shift(6_100, 0.95, true, true),
    shift(7_000, 0.9),
  ];
  const first = api.read();
  expect(first.layoutShiftSum).toBeCloseTo(4.5);
  expect(first.mediaAttributedShiftSum).toBeCloseTo(1.8);
  expect(first.maxSessionWindowShift).toBeCloseTo(2.1);
  expect(first.shifts).toHaveLength(9);
  expect(first.shifts[0]?.sources[0]?.media).toBe(true);
  expect(first.shifts[1]?.sources[0]?.media).toBe(false);
  expect(first).not.toHaveProperty("cls");
  expect(first).not.toHaveProperty("mediaCls");
  const prefix = [...first.shifts];
  expect(api.read()).toEqual(first);

  observer.deliver([shift(8_000, 0.4)]);
  const next = api.read();
  expect(next.layoutShiftSum).toBeCloseTo(4.9);
  expect(next.maxSessionWindowShift).toBeCloseTo(2.1);
  expect(next.shifts.slice(0, prefix.length)).toEqual(prefix);

  observer.pending.push(shift(9_000, 10));
  api.reset();
  expect(api.read()).toMatchObject({
    layoutShiftSum: 0,
    mediaAttributedShiftSum: 0,
    maxSessionWindowShift: 0,
    shifts: [],
  });
  observer.deliver([shift(10_000, 0.25)]);
  expect(api.read().maxSessionWindowShift).toBe(0.25);
});

it("keeps all layout-shift metrics null when the native entry type is unsupported", () => {
  LayoutObserver.supportedEntryTypes = [];
  installControlUiMediaObserver();
  expect(LayoutObserver.current).toBeUndefined();
  expect(window.controlUiMediaBench.read()).toMatchObject({
    nativeLayoutShiftSupported: false,
    layoutShiftSum: null,
    mediaAttributedShiftSum: null,
    maxSessionWindowShift: null,
    shifts: [],
  });
});
