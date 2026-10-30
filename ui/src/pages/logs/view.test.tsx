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
    onScroll: vi.fn(),
    onStreamRef: (element) => {
      // jsdom has no native scrolling; browser scenarios cover reader positioning.
      element.scrollTo = () => undefined;
    },
    ...overrides,
  };
}

beforeEach(installLogsViewport);

afterEach(async () => {
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
