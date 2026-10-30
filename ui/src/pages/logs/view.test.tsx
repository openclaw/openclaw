/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { installLogsViewport } from "./logs-layout.test-support.ts";
import { LogsView, type LogsProps } from "./view.tsx";

const raw = '{"level":"info","message":"matched line"}';

function createProps(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    completion: null,
    refreshDisabled: false,
    status: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
    file: null,
    entries: [{ id: 0, raw, level: "info" }],
    filterText: "",
    levelFilters: { trace: true, debug: true, info: true, warn: true, error: true, fatal: true },
    autoFollow: true,
    truncated: false,
    onFilterTextChange: vi.fn(),
    onLevelToggle: vi.fn(),
    onToggleAutoFollow: vi.fn(),
    onRefresh: vi.fn(),
    onExport: vi.fn(),
    onStreamRef: (element) => {
      // jsdom has no native scrolling; browser scenarios cover reader positioning.
      element.scrollTo = () => undefined;
    },
    ...overrides,
  };
}

beforeEach(installLogsViewport);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
});

it("formats only new rows until the locale or effective timezone changes", async () => {
  const validTimes = ["2026-09-22T12:00:37Z", "1970-01-01T00:00:00Z"];
  const allTimes = [...validTimes, "not a timestamp", "", null, undefined];
  const props = createProps({
    status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
    entries: allTimes.map((time, index) => ({
      id: index,
      time,
      raw: "log entry",
      message: index === 0 ? "keep initial" : "other entry",
    })),
  });
  const [entries, setEntries] = createSignal(props.entries);
  const [filterText, setFilterText] = createSignal("");
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  let timeZone = "UTC";
  const formatCalls: Array<ReturnType<typeof vi.fn<Intl.DateTimeFormat["format"]>>> = [];
  // Model an OS timezone change while retaining native Intl timestamp formatting.
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    const formatter = new NativeDateTimeFormat(locales, { ...options, timeZone });
    const format = vi.fn(formatter.format.bind(formatter));
    formatCalls.push(format);
    Object.defineProperty(formatter, "format", { value: format });
    return formatter;
  });
  const { container } = mountSolid(() => (
    <LogsView
      {...props}
      entries={entries()}
      filterText={filterText()}
      onFilterTextChange={setFilterText}
    />
  ));
  const filterInput = container.querySelector<HTMLInputElement>(".settings-input")!;

  const expectTimes = (times: typeof allTimes, locale = "en", formats?: number) => {
    flush();
    if (formats !== undefined) {
      expect(formatCalls.flatMap((format) => format.mock.calls)).toHaveLength(formats);
    }
    const native = new NativeDateTimeFormat(locale, { timeStyle: "short", timeZone });
    const expected = times.map((time) => {
      const date = new Date(time ?? "");
      return !time ? "" : Number.isNaN(date.getTime()) ? time : native.format(date);
    });
    expect(Array.from(container.querySelectorAll(".log-time"), (row) => row.textContent)).toEqual(
      expected,
    );
    formatCalls.forEach((format) => format.mockClear());
  };

  expectTimes(allTimes, "en");
  for (const locale of ["fr", "en"] as const) {
    await i18n.setLocale(locale);
    expectTimes(allTimes, locale);
  }

  const appendedTime = "2026-09-22T18:10:00Z";
  setEntries((rows) => [
    ...rows,
    { id: allTimes.length, time: appendedTime, raw: "keep appended" },
  ]);
  expectTimes([...allTimes, appendedTime], "en", 1);

  filterInput.value = "keep";
  filterInput.dispatchEvent(new Event("input", { bubbles: true }));
  expectTimes([validTimes[0], appendedTime], "en", 0);

  timeZone = "America/Los_Angeles";
  const nextTime = "2026-09-22T20:00:00Z";
  setEntries((rows) => [...rows, { id: allTimes.length + 1, time: nextTime, raw: "keep next" }]);
  expectTimes([validTimes[0], appendedTime, nextTime], "en");

  timeZone = "Asia/Tokyo";
  filterInput.value = "initial";
  filterInput.dispatchEvent(new Event("input", { bubbles: true }));
  expectTimes([validTimes[0]], "en");
});

it("keeps the visible export filename suffix stable when labels are localized", async () => {
  i18n.registerTranslation("pt-BR", {
    gatewayLogs: {
      exportButton: "Exportar {label}",
      exportLabels: { filtered: "filtrado", visible: "visivel" },
    },
  });
  await i18n.setLocale("pt-BR");
  const onExport = vi.fn();
  const view = mountSolid(() => <LogsView {...createProps({ onExport })} />);
  flush();
  view.getByRole("button", { name: "Exportar visivel" }).click();

  expect(onExport).toHaveBeenCalledWith([raw], "visible");
});

it("keeps following appended logs when a row resizes before compensation is read back", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const observers: Array<{
    callback: ResizeObserverCallback;
    targets: Set<Element>;
    observer: ResizeObserver;
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets, observer: this });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const heights = new WeakMap<Element, number>();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
    return this.classList.contains("log-stream") ? 380 : (heights.get(this) ?? 44);
  });
  const lines = (count: number) =>
    Array.from({ length: count }, (_, id) => ({ id, raw: `line ${id}` }));
  const [entries, setEntries] = createSignal(lines(500));
  let stream!: HTMLDivElement;
  let jump!: () => void;
  let top = 0;
  const view = mountSolid(() => (
    <LogsView
      {...createProps({
        status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
        onStreamRef: (element, scroll) => {
          stream = element;
          jump = scroll;
          const height = () =>
            Number.parseFloat(
              element.querySelector<HTMLElement>('[role="list"]')?.style.height ?? "0",
            );
          Object.defineProperties(element, {
            clientHeight: { get: () => 378 },
            scrollHeight: { get: height },
            scrollTop: {
              get: () => (top = Math.min(top, Math.max(0, height() - 378))),
              set: (value: number) => {
                top = Math.max(0, Math.min(value, height() - 378));
              },
            },
          });
          element.scrollTo = (options: ScrollToOptions | number, y?: number) => {
            element.scrollTop = typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
          };
        },
      })}
      entries={entries()}
    />
  ));
  const frame = () => {
    vi.advanceTimersByTime(16);
    flush();
  };
  const readBack = () => stream.dispatchEvent(new Event("scroll"));
  const resize = (row: Element) => {
    heights.set(row, 91);
    for (const observer of observers) {
      if (!observer.targets.has(row)) {
        continue;
      }
      const size = [{ inlineSize: 900, blockSize: 91 }];
      observer.callback(
        [
          {
            target: row,
            borderBoxSize: size,
            contentBoxSize: size,
            devicePixelContentBoxSize: size,
            contentRect: new DOMRect(0, 0, 900, 91),
          },
        ],
        observer.observer,
      );
    }
  };
  try {
    flush();
    jump();
    frame();
    readBack();
    for (let index = 0; index < 4; index++) {
      frame();
    }
    const rows = Array.from(stream.querySelectorAll(".log-row"));
    resize(rows[0]!);
    resize(rows[1]!);
    vi.advanceTimersByTime(16);
    // The spacer commits before the clamped scroll event, then compensation retries next frame.
    flush();
    readBack();
    frame();
    const afterCompensation = stream.scrollTop;
    expect(rows[2]!.isConnected).toBe(true);
    resize(rows[2]!);
    frame();
    expect(stream.scrollTop).toBeGreaterThanOrEqual(afterCompensation);
    readBack();
    setEntries(lines(1000));
    flush();
    for (let index = 0; index < 5; index++) {
      frame();
      readBack();
    }
    expect(stream.querySelector('[aria-posinset="1000"]')).not.toBeNull();
    expect(stream.scrollHeight - stream.scrollTop - stream.clientHeight).toBeLessThan(2);
  } finally {
    view.unmount();
  }
});
