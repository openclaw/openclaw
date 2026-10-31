/* @vitest-environment jsdom */

import { createSignal, flush, onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
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

function installClampedLogsViewport(
  element: HTMLDivElement,
  clientHeight: number,
  onScroll?: () => void,
) {
  let top = 0;
  const height = () =>
    Number.parseFloat(element.querySelector<HTMLElement>('[role="list"]')?.style.height ?? "0");
  Object.defineProperties(element, {
    clientHeight: { get: () => clientHeight },
    scrollHeight: { get: height },
    scrollTop: {
      get: () => (top = Math.min(top, Math.max(0, height() - clientHeight))),
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height() - clientHeight));
      },
    },
  });
  element.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    const previous = element.scrollTop;
    element.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    if (previous !== element.scrollTop) {
      onScroll?.();
    }
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

it("checks default filters once per batch and keeps the first retained row in order", () => {
  const levelReads = vi.fn(() => true);
  const props = createProps({
    status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
    onExport: vi.fn(),
  });
  for (const level of Object.keys(props.levelFilters)) {
    Object.defineProperty(props.levelFilters, level, { get: levelReads });
  }
  const lines = Array.from({ length: 84 }, (_, id) => ({
    id,
    raw: `line ${id}`,
    level: "info" as const,
  }));
  const [entries, setEntries] = createSignal(lines.slice(0, 64));
  const view = mountSolid(() => <LogsView {...props} entries={entries()} />);
  flush();
  levelReads.mockClear();

  setEntries(lines.slice(20));
  flush();

  expect(levelReads).toHaveBeenCalledTimes(6);
  expect(view.container.querySelector('[aria-posinset="1"] .log-message')?.textContent).toBe(
    "line 20",
  );
  view.getByRole("button", { name: "Export visible" }).click();
  expect(props.onExport).toHaveBeenCalledWith(
    Array.from({ length: 64 }, (_, index) => `line ${index + 20}`),
    "visible",
  );
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

it.each(["follow", "queued-follow", "reader"] as const)(
  "preserves scroll intent through row resizes (%s)",
  (mode) => {
    const queuedResize = mode === "queued-follow";
    const reader = mode === "reader";
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
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
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("log-stream") ? 380 : (heights.get(this) ?? 44);
    });
    const lines = (count: number) =>
      Array.from({ length: count }, (_, id) => ({ id, raw: `line ${id}` }));
    const [entries, setEntries] = createSignal(lines(500));
    let stream!: HTMLDivElement;
    let jump!: () => void;
    const view = mountSolid(() => (
      <LogsView
        {...createProps({
          autoFollow: !reader,
          status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
          onStreamRef: (element, scroll) => {
            stream = element;
            jump = scroll;
            installClampedLogsViewport(element, 378);
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
      if (reader) {
        // The stream's border is outside the viewport; this reader has not reached the end.
        stream.scrollTop -= 2;
        stream.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000 }));
        readBack();
      }
      const readerTop = stream.scrollTop;
      const rows = Array.from(stream.querySelectorAll(".log-row"));
      resize(rows[0]!);
      resize(rows[1]!);
      vi.advanceTimersByTime(16);
      if (queuedResize) {
        // This observer frame is already queued when the measured spacer commits.
        resize(rows[2]!);
      }
      // The spacer commits before the clamped scroll event and the next queued row measurement.
      flush();
      readBack();
      frame();
      if (reader) {
        expect(stream.scrollTop).toBe(readerTop);
        vi.advanceTimersByTime(200);
        flush();
        resize(rows[2]!);
        frame();
        expect(stream.scrollTop).toBe(readerTop + 47);
        return;
      }
      expect(stream.scrollHeight - stream.scrollTop - stream.clientHeight).toBeLessThan(2);
      const afterCompensation = stream.scrollTop;
      const nextRow = rows[queuedResize ? 3 : 2]!;
      expect(nextRow.isConnected).toBe(true);
      resize(nextRow);
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
  },
);

it("keeps an in-flight hidden append at the end when the page becomes visible", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  // Browsers suspend RAF while hidden, but an in-flight response can still settle.
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextCallback = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextCallback;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const frame = () => {
    vi.advanceTimersByTime(16);
    // eslint-disable-next-line unicorn/no-useless-spread -- Newly scheduled callbacks belong to the next frame.
    for (const [id, callback] of [...callbacks]) {
      if (callbacks.delete(id)) {
        callback(performance.now());
      }
    }
    flush();
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("log-stream")
      ? 636
      : Number(this.dataset.index) % 7 === 0
        ? 92
        : 42;
  });
  const lines = (count: number) =>
    Array.from({ length: count }, (_, id) => ({ id, raw: `line ${id}` }));
  const [entries, setEntries] = createSignal<LogsProps["entries"]>([]);
  const [loaded, setLoaded] = createSignal(false);
  let stream!: HTMLDivElement;
  let jump!: () => void;
  let scrollFrame: number | undefined;
  const responses: Array<ReturnType<typeof Promise.withResolvers<LogsProps["entries"]>>> = [];
  const view = mountSolid(() => {
    const polling = useVisiblePoll(2_000, () => {
      const response = Promise.withResolvers<LogsProps["entries"]>();
      responses.push(response);
      void response.promise.then(setEntries);
    });
    onSettled(() => {
      polling.start();
    });
    return (
      <LogsView
        {...createProps({
          onStreamRef: (element, scroll) => {
            stream = element;
            jump = scroll;
            installClampedLogsViewport(element, 634, () => {
              if (scrollFrame === undefined) {
                scrollFrame = requestAnimationFrame(() => {
                  scrollFrame = undefined;
                  element.dispatchEvent(new Event("scroll"));
                });
              }
            });
          },
        })}
        status={{ error: null, hasLoaded: loaded(), stale: false, awaitingGateway: false }}
        entries={entries()}
      />
    );
  });
  try {
    flush();
    setEntries(lines(500));
    setLoaded(true);
    flush();
    // Match the real page: the first successful load requests its initial end jump.
    jump();
    for (let index = 0; index < 8; index++) {
      frame();
    }
    expect(stream.querySelector('[aria-posinset="500"]')).not.toBeNull();
    expect(stream.scrollHeight - stream.scrollTop - stream.clientHeight).toBeLessThan(2);

    // The visible poll starts one request, then the page becomes hidden.
    vi.advanceTimersByTime(2_000 - performance.now());
    expect(responses).toHaveLength(1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    responses[0]!.resolve(lines(1_000));
    await Promise.resolve();
    flush();
    const followArmedAt = stream.ownerDocument.defaultView!.performance.now();
    expect(callbacks.size).toBeGreaterThan(0);

    // The real visibility owner suspends polling; only the in-flight append commits.
    vi.advanceTimersByTime(5_001);
    expect(responses).toHaveLength(1);
    expect(stream.ownerDocument.defaultView!.performance.now() - followArmedAt).toBe(5_001);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(responses).toHaveLength(2);

    frame();
    for (let index = 0; index < 8; index++) {
      frame();
    }
    const geometry = {
      top: stream.scrollTop,
      height: stream.scrollHeight,
      viewport: stream.clientHeight,
      first: stream.querySelector(".log-row")?.getAttribute("aria-posinset"),
      last: stream.querySelector(".log-row:last-child")?.getAttribute("aria-posinset"),
      elapsed: stream.ownerDocument.defaultView!.performance.now() - followArmedAt,
      requests: responses.length,
    };
    expect(stream.querySelector('[aria-posinset="1000"]'), JSON.stringify(geometry)).not.toBeNull();
    expect(
      stream.scrollHeight - stream.scrollTop - stream.clientHeight,
      JSON.stringify(geometry),
    ).toBeLessThan(2);
  } finally {
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
    }
    view.unmount();
  }
});
