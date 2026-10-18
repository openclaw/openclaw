/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { LogLevel } from "./log-lines.ts";
import { LogsView, type LogsProps } from "./view.tsx";

const views = new Map<Element, () => void>();
function renderView(props: LogsProps, container: HTMLDivElement) {
  views.get(container)?.();
  views.set(container, mountSolid(() => <LogsView {...props} />, { container }).unmount);
  flush();
}

function createLevelFilters(overrides: Partial<Record<LogLevel, boolean>> = {}) {
  return {
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
    ...overrides,
  };
}

function createProps(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    loading: false,
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
    levelFilters: createLevelFilters(),
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

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} button`);
  }
  return button;
}

async function useTestPortugueseLogsLabels() {
  i18n.registerTranslation("pt-BR", {
    gatewayLogs: {
      title: "Registros",
      subtitle: "Registros do Gateway em JSONL.",
      exportButton: "Exportar {label}",
      exportLabels: {
        filtered: "filtrado",
        visible: "visivel",
      },
      filter: "Filtro",
      searchPlaceholder: "Pesquisar registros",
      autoFollow: "Acompanhar automaticamente",
      file: "Arquivo: {file}",
      truncated: "Saida truncada.",
      empty: "Nenhuma entrada.",
    },
  });
  await i18n.setLocale("pt-BR");
}

afterEach(async () => {
  for (const dispose of views.values()) {
    dispose();
  }
  views.clear();
  vi.restoreAllMocks();
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
});

describe("LogsView", () => {
  it("refreshes one formatter per locale, incoming-row, and filter update on the mounted view", async () => {
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
    // Model an OS timezone change while retaining native Intl timestamp formatting.
    const formatterSetups = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(function (locales, options) {
        return new NativeDateTimeFormat(locales, { ...options, timeZone });
      });
    const timeCalls = vi.spyOn(Date.prototype, "toLocaleTimeString");
    views.set(
      container,
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
      ).unmount,
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
    };

    flush();
    expectTimes(allTimes, "en");
    for (const locale of ["fr", "en"] as const) {
      await i18n.setLocale(locale);
      flush();
      expectTimes(allTimes, locale);
    }

    timeZone = "America/Los_Angeles";
    const appendedTime = "2026-09-22T18:10:00Z";
    setEntries([...props.entries, { time: appendedTime, raw: "keep appended" }]);
    flush();
    expectTimes([...allTimes, appendedTime], "en");

    timeZone = "Asia/Tokyo";
    filterInput.value = "keep";
    filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expectTimes([validTimes[0], appendedTime], "en");
  });

  it("does not claim the log is empty before the initial load completes", () => {
    const container = document.createElement("div");

    renderView(createProps({ loading: true, entries: [] }), container);

    expect(container.textContent).not.toContain("No log entries.");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("does not show loading when no initial request is pending", () => {
    const container = document.createElement("div");

    renderView(createProps({ loading: false, entries: [] }), container);

    expect(container.textContent).not.toContain("No log entries.");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("disables refresh actions while the gateway cannot accept them", () => {
    const container = document.createElement("div");

    renderView(
      createProps({
        refreshDisabled: true,
        status: {
          error: "logs unavailable",
          hasLoaded: false,
          stale: false,
          awaitingGateway: false,
        },
      }),
      container,
    );

    expect(
      container.querySelector<HTMLButtonElement>(".settings-section__actions .btn")?.disabled,
    ).toBe(true);
    expect(container.querySelector(".logs-refresh-status button")).toBeNull();
  });

  it.each([
    { buttonText: "Exportar visivel", expectedLabel: "visible", filterText: "" },
    { buttonText: "Exportar filtrado", expectedLabel: "filtered", filterText: "matched" },
  ])(
    "keeps the $expectedLabel export filename suffix stable when labels are localized",
    async ({ buttonText, expectedLabel, filterText }) => {
      await useTestPortugueseLogsLabels();
      const onExport = vi.fn();
      const container = document.createElement("div");

      renderView(createProps({ filterText, onExport }), container);
      buttonByText(container, buttonText).click();

      expect(onExport).toHaveBeenCalledWith(
        ['{"level":"info","message":"matched line"}'],
        expectedLabel,
      );
    },
  );

  it("renders the error and stale marker without a retry button or hiding loaded logs", () => {
    const container = document.createElement("div");

    renderView(
      createProps({
        status: {
          error: "logs unavailable",
          hasLoaded: true,
          stale: true,
          awaitingGateway: false,
        },
      }),
      container,
    );

    const status = container.querySelector(".logs-refresh-status");
    expect(status?.textContent).toContain("logs unavailable");
    expect(status?.textContent).toContain("Showing stale data");
    expect(container.textContent).toContain("matched line");
    expect(status?.querySelector("button")).toBeNull();
  });
});
