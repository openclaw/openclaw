/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { LogsView, type LogsProps } from "./view.tsx";

function createProps(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    completion: null,
    refreshDisabled: false,
    status: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
    file: null,
    entries: [
      {
        raw: '{"level":"info","message":"matched line"}',
        time: "2026-06-14T12:00:00Z",
        level: "info",
        subsystem: "gateway",
        message: "matched line",
      },
    ],
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
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
});

describe("LogsView", () => {
  it("formats only new rows until the locale or effective timezone changes", async () => {
    const container = document.createElement("div");
    const validTimes = ["2026-09-22T12:00:37Z", "1970-01-01T00:00:00Z"];
    const allTimes = [...validTimes, "not a timestamp", "", null, undefined];
    const props = createProps({
      status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
      entries: allTimes.map((time, index) => ({
        time,
        raw: "log entry",
        message: index === 0 ? "keep initial" : "other entry",
      })),
    });
    const [entries, setEntries] = createSignal(props.entries);
    const [filterText, setFilterText] = createSignal("");
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    let timeZone = "UTC";
    const formatCalls = vi.fn();
    // Model an OS timezone change while retaining native Intl timestamp formatting.
    const formatterSetups = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(function (locales, options) {
        const formatter = new NativeDateTimeFormat(locales, { ...options, timeZone });
        const format = formatter.format.bind(formatter);
        Object.defineProperty(formatter, "format", {
          value: (value?: number | Date) => {
            formatCalls(value);
            return format(value);
          },
        });
        return formatter;
      });
    const timeCalls = vi.spyOn(Date.prototype, "toLocaleTimeString");
    mountSolid(
      () => (
        <LogsView
          {...props}
          entries={entries()}
          filterText={filterText()}
          onFilterTextChange={setFilterText}
        />
      ),
      { container },
    );
    const filterInput = container.querySelector<HTMLInputElement>(".settings-input")!;

    const expectTimes = (times: typeof allTimes, locale: string) => {
      const native = new NativeDateTimeFormat(locale, { timeStyle: "short", timeZone });
      const expected = times.map((time) => {
        if (!time) {
          return "";
        }
        const date = new Date(time);
        return Number.isNaN(date.getTime()) ? time : native.format(date);
      });
      expect(Array.from(container.querySelectorAll(".log-time"), (row) => row.textContent)).toEqual(
        expected,
      );
      expect(timeCalls.mock.calls.length + formatterSetups.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      timeCalls.mockClear();
      formatterSetups.mockClear();
      formatCalls.mockClear();
    };

    flush();
    expectTimes(allTimes, "en");
    for (const locale of ["fr", "en"] as const) {
      await i18n.setLocale(locale);
      flush();
      expectTimes(allTimes, locale);
    }

    const appendedTime = "2026-09-22T18:10:00Z";
    const appendedEntry = { time: appendedTime, raw: "keep appended" };
    setEntries([...props.entries, appendedEntry]);
    flush();
    expect(formatCalls).toHaveBeenCalledTimes(1);
    expectTimes([...allTimes, appendedTime], "en");

    filterInput.value = "keep";
    filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(formatCalls).not.toHaveBeenCalled();
    expectTimes([validTimes[0], appendedTime], "en");

    timeZone = "America/Los_Angeles";
    const nextTime = "2026-09-22T20:00:00Z";
    setEntries([...props.entries, appendedEntry, { time: nextTime, raw: "keep next" }]);
    flush();
    expectTimes([validTimes[0], appendedTime, nextTime], "en");

    timeZone = "Asia/Tokyo";
    filterInput.value = "initial";
    filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
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
    const props = createProps({ onExport });
    const view = mountSolid(() => <LogsView {...props} />);
    flush();
    view.getByRole("button", { name: "Exportar visivel" }).click();

    expect(onExport).toHaveBeenCalledWith(['{"level":"info","message":"matched line"}'], "visible");
  });
});
