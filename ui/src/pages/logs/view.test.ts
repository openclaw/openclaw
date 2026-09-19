/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import type { LogLevel } from "./log-lines.ts";
import { renderLogs } from "./view.ts";

type LogsProps = Parameters<typeof renderLogs>[0];

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
  vi.restoreAllMocks();
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
});

describe("renderLogs", () => {
  it("bounds time formatting setup per render while preserving localized timestamps", async () => {
    const container = document.createElement("div");
    const times = [
      ...Array.from({ length: 254 }, (_, index) =>
        new Date(Date.UTC(2026, 8, 18, 12, index, 37)).toISOString(),
      ),
      "1970-01-01T00:00:00Z",
      "not a timestamp",
      "",
      undefined,
    ];
    const props = createProps({
      status: { error: null, hasLoaded: true, stale: false, awaitingGateway: false },
      entries: times.map((time) => ({ time, raw: "log entry" })),
    });
    const timeCalls = vi.spyOn(Date.prototype, "toLocaleTimeString");
    const formatterSetups = vi.spyOn(Intl, "DateTimeFormat");

    for (const locale of ["en", "fr", "en"] as const) {
      await i18n.setLocale(locale);
      const expected = times.map((time) => {
        if (!time) {
          return "";
        }
        const date = new Date(time);
        return Number.isNaN(date.getTime())
          ? time
          : date.toLocaleTimeString(locale, { timeStyle: "short" });
      });
      timeCalls.mockClear();
      formatterSetups.mockClear();

      render(renderLogs(props), container);

      expect(Array.from(container.querySelectorAll(".log-time"), (row) => row.textContent)).toEqual(
        expected,
      );
      // Native toLocaleTimeString prepares its formatter internally too.
      expect(timeCalls.mock.calls.length + formatterSetups.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("does not claim the log is empty before the initial load completes", () => {
    const container = document.createElement("div");

    render(renderLogs(createProps({ loading: true, entries: [] })), container);

    expect(container.textContent).not.toContain("No log entries.");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("does not show loading when no initial request is pending", () => {
    const container = document.createElement("div");

    render(renderLogs(createProps({ loading: false, entries: [] })), container);

    expect(container.textContent).not.toContain("No log entries.");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("disables refresh actions while the gateway cannot accept them", () => {
    const container = document.createElement("div");

    render(
      renderLogs(
        createProps({
          refreshDisabled: true,
          status: {
            error: "logs unavailable",
            hasLoaded: false,
            stale: false,
            awaitingGateway: false,
          },
        }),
      ),
      container,
    );

    expect(
      container.querySelector<HTMLButtonElement>(".settings-section__actions .btn")?.disabled,
    ).toBe(true);
    expect(container.querySelector(".logs-refresh-status button")).toBeNull();
  });

  it("renders the subtitle under the section header", () => {
    const container = document.createElement("div");

    render(renderLogs(createProps()), container);

    expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
      "Gateway file logs (JSONL).",
    );
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

      render(renderLogs(createProps({ filterText, onExport })), container);
      buttonByText(container, buttonText).click();

      expect(onExport).toHaveBeenCalledWith(
        ['{"level":"info","message":"matched line"}'],
        expectedLabel,
      );
    },
  );

  it("renders the error and stale marker without a retry button or hiding loaded logs", () => {
    const container = document.createElement("div");

    render(
      renderLogs(
        createProps({
          status: {
            error: "logs unavailable",
            hasLoaded: true,
            stale: true,
            awaitingGateway: false,
          },
        }),
      ),
      container,
    );

    const status = container.querySelector(".logs-refresh-status");
    expect(status?.textContent).toContain("logs unavailable");
    expect(status?.textContent).toContain("Showing stale data");
    expect(container.textContent).toContain("matched line");
    expect(status?.querySelector("button")).toBeNull();
  });
});
