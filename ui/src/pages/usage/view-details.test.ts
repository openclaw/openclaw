import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionUsageTimePoint } from "../../../../src/shared/session-usage-timeseries-types.js";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { i18n, t } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SessionLogEntry, UsageProps, UsageSessionEntry } from "./types.ts";
import { SessionDetailPanel } from "./view-details.tsx";
import { text, texts } from "./view-render.test-support.ts";
import { createUsageProps } from "./view.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function point(overrides: Partial<SessionUsageTimePoint> = {}): SessionUsageTimePoint {
  return {
    timestamp: 1000,
    totalTokens: 100,
    cost: 0.1,
    input: 30,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cumulativeTokens: 100,
    cumulativeCost: 0.1,
    ...overrides,
  };
}

function session(): UsageSessionEntry & { usage: NonNullable<UsageSessionEntry["usage"]> } {
  return {
    key: "agent:main:detail",
    label: "Detail session",
    usage: {
      ...createEmptyCostUsageTotals(),
      totalTokens: 1000,
      totalCost: 1,
      input: 300,
      output: 400,
      cacheRead: 200,
      cacheWrite: 100,
      durationMs: 60_000,
      firstActivity: 0,
      lastActivity: 60_000,
      messageCounts: { total: 10, user: 5, assistant: 5, toolCalls: 0, toolResults: 0, errors: 0 },
    },
  };
}

function toolUsage(read = 4, exec = 3) {
  return {
    totalCalls: read + exec,
    uniqueTools: 2,
    tools: [
      { name: "read", count: read },
      { name: "exec", count: exec },
    ],
  };
}

function expectText(root: ParentNode, selector: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text(root, selector)).toContain(part);
  }
}

function summary(root: ParentNode) {
  return [...root.querySelectorAll(".session-summary-card")].map((card) => ({
    value: text(card, ".session-summary-value"),
    meta: text(card, ".session-summary-meta")?.replaceAll(/\s+/g, " ").trim(),
  }));
}

function log(timestamp: number, role: SessionLogEntry["role"], content: string): SessionLogEntry {
  return { timestamp, role, content };
}

function toolRows(root: ParentNode) {
  return [...root.querySelectorAll(".usage-list-item")].map((item) => [
    item.firstElementChild?.textContent,
    text(item, ".usage-list-value > span"),
  ]);
}

function contextFile(
  name: string,
  chars: number,
  native = false,
): NonNullable<UsageSessionEntry["contextWeight"]>["injectedWorkspaceFiles"][number] {
  return {
    name,
    path: `/synthetic/${name}`,
    missing: false,
    rawChars: chars,
    ...(native
      ? { injectionStatus: "native_unverified", injectedChars: null, truncated: null }
      : { injectedChars: chars, truncated: false }),
  };
}

function mount(
  points: SessionUsageTimePoint[],
  {
    start = null,
    end = null,
    breakdownMode = "total",
    filters = {},
    ...errors
  }: {
    start?: number | null;
    end?: number | null;
    breakdownMode?: "total" | "by-type";
    filters?: Partial<
      Pick<UsageProps["filters"], "startDate" | "endDate" | "selectedDays" | "timeZone">
    >;
    timeSeries?: string;
    sessionLogs?: string;
    sessionLogsData?: SessionLogEntry[] | null;
    sessionLogsHasLoaded?: boolean;
    logFilters?: UsageProps["detail"]["logFilters"];
    session?: UsageSessionEntry;
    stale?: boolean;
    contextWeight?: UsageSessionEntry["contextWeight"];
    onToggleContextExpanded?: () => void;
    onCursorRangeChange?: (start: number | null, end: number | null) => void;
  } = {},
) {
  const stale = errors.stale ?? false;
  const status = (error: string | null = null, hasLoaded = stale): PanelRefreshStatus => ({
    error,
    hasLoaded,
    stale,
    awaitingGateway: false,
  });
  const container = document.createElement("div");
  const defaults = createUsageProps();
  const [cursor, setCursor] = createSignal({ start, end });
  const [contextExpanded, setContextExpanded] = createSignal(false);
  mountSolid(
    () =>
      SessionDetailPanel({
        session: { ...(errors.session ?? session()), contextWeight: errors.contextWeight },
        detail: {
          ...defaults.detail,
          timeSeries: { points },
          timeSeriesStatus: status(errors.timeSeries),
          timeSeriesMode: "per-turn",
          timeSeriesBreakdownMode: breakdownMode,
          get timeSeriesCursorStart() {
            return cursor().start;
          },
          get timeSeriesCursorEnd() {
            return cursor().end;
          },
          sessionLogs: errors.sessionLogsData === undefined ? [] : errors.sessionLogsData,
          sessionLogsStatus: status(errors.sessionLogs, errors.sessionLogsHasLoaded),
          logFilters: errors.logFilters ?? defaults.detail.logFilters,
          context: { weight: errors.contextWeight, loading: false, read: null, status: status() },
        },
        callbacks: {
          ...defaults.callbacks.details,
          onTimeSeriesCursorRangeChange: (nextStart, nextEnd) => {
            setCursor({ start: nextStart, end: nextEnd });
            errors.onCursorRangeChange?.(nextStart, nextEnd);
          },
          onToggleContextExpanded: () => {
            setContextExpanded((current) => !current);
            errors.onToggleContextExpanded?.();
          },
        },
        range: { startDate: "", endDate: "", selectedDays: [], timeZone: "local", ...filters },
        get contextExpanded() {
          return contextExpanded();
        },
        onClose: vi.fn(),
      }),
    { container },
  );
  flush();
  return container;
}

it.each([
  { key: "ArrowLeft", start: null, end: null, expected: [1000, 3000] },
  { key: "Home", start: 2000, end: 3000, expected: [2000, 2000] },
  { key: "End", start: 2000, end: 3000, expected: [2000, 4000] },
])("adjusts the right range handle with $key from $start–$end", ({ key, start, end, expected }) => {
  const onCursorRangeChange = vi.fn();
  const container = mount(
    [1000, 2000, 3000, 4000].map((timestamp) => point({ timestamp })),
    { start, end, onCursorRangeChange },
  );
  const handle = container.querySelector<HTMLElement>(".chart-handle-right")!;
  expect(handle.getAttribute("role")).toBe("slider");
  expect(handle.tabIndex).toBe(0);
  expect(handle.getAttribute("aria-label")).toBe("Range end");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  handle.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(onCursorRangeChange).toHaveBeenCalledExactlyOnceWith(...expected);
});

it("retains the focused handle through consecutive cursor adjustments", () => {
  const onCursorRangeChange = vi.fn();
  const container = mount(
    [1000, 2000, 3000, 4000].map((timestamp) => point({ timestamp })),
    { onCursorRangeChange },
  );
  document.body.append(container);
  const handle = container.querySelector<HTMLElement>(".chart-handle-left")!;
  handle.focus();
  for (const timestamp of [2000, 3000]) {
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flush();
    expect(container.querySelector(".chart-handle-left")).toBe(handle);
    expect(document.activeElement).toBe(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(timestamp));
    expect(onCursorRangeChange).toHaveBeenLastCalledWith(timestamp, 4000);
    expect(text(container, ".session-detail-stats")).toContain(
      `${timestamp === 2000 ? 300 : 200} tokens`,
    );
  }
});

it("retains manually expanded log tools across a cursor update", () => {
  const container = mount(
    [1000, 2000, 3000, 4000].map((timestamp) => point({ timestamp })),
    {
      sessionLogsData: [log(3, "assistant", "[Tool: read]")],
      sessionLogsHasLoaded: true,
    },
  );
  const tools = container.querySelector<HTMLDetailsElement>(".session-log-tools")!;
  tools.open = true;
  container
    .querySelector(".chart-handle-left")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  flush();
  expect(container.querySelector(".session-log-tools")).toBe(tools);
  expect(tools.open).toBe(true);
});

it("filters detail points by the selected UTC day and keeps the final millisecond", () => {
  const localOffsetMs = 8 * 60 * 60 * 1000;
  for (const [local, utc] of [
    ["getFullYear", "getUTCFullYear"],
    ["getMonth", "getUTCMonth"],
    ["getDate", "getUTCDate"],
  ] as const) {
    vi.spyOn(Date.prototype, local).mockImplementation(function (this: Date) {
      return new Date(this.getTime() + localOffsetMs)[utc]();
    });
  }
  const points = [
    point({ timestamp: Date.parse("2026-05-13T18:00:00.000Z") }),
    point({ timestamp: Date.parse("2026-05-13T23:59:59.999Z") }),
  ];
  const filters = {
    startDate: "2026-05-13",
    endDate: "2026-05-13",
    selectedDays: ["2026-05-13"],
  };
  const utc = mount(points, { filters: { ...filters, timeZone: "utc" } });
  const local = mount(points, { filters: { ...filters, timeZone: "local" } });
  expect(utc.querySelectorAll(".ts-bar")).toHaveLength(2);
  expect(local.querySelectorAll(".ts-bar")).toHaveLength(0);
  expect(local.querySelector(".usage-empty-block")).not.toBeNull();
});

it("keeps interval header totals on the timeline's selected days", () => {
  const start = Date.parse("2026-05-13T12:00:00Z");
  const end = Date.parse("2026-05-15T12:00:00Z");
  const container = mount(
    [
      point({ timestamp: start, totalTokens: 100, cost: 0.1 }),
      point({ timestamp: Date.parse("2026-05-14T12:00:00Z"), totalTokens: 900, cost: 9 }),
      point({ timestamp: end, totalTokens: 200, cost: 0.2 }),
    ],
    {
      start,
      end,
      filters: {
        startDate: "2026-05-13",
        endDate: "2026-05-15",
        selectedDays: ["2026-05-13", "2026-05-15"],
        timeZone: "utc",
      },
      sessionLogsHasLoaded: true,
      sessionLogsData: [
        log(start, "assistant", "[Tool: read]\nSelected May 13"),
        log(Date.parse("2026-05-14T12:00:00Z"), "assistant", "[Tool: exec]\nDeselected May 14"),
        log(end / 1000, "assistant", "[Tool: read]\nSelected May 15"),
        log(0, "user", "Undated entry remains visible"),
      ],
    },
  );

  expect(container.querySelectorAll(".ts-bar")).toHaveLength(2);
  expectText(container, ".timeseries-summary", "$0.30");
  expectText(container, ".session-detail-stats", "300 tokens", "$0.30");
  expect(summary(container)).toMatchObject([{ value: "2" }, { value: "2" }, {}, {}]);
  expectText(container, ".session-logs-header-count", "3 of 4");
  expect(container.textContent).not.toContain("Deselected May 14");
  expect(container.textContent).toContain("Selected May 13");
  expect(container.textContent).toContain("Selected May 15");
  expect(container.textContent).toContain("Undated entry remains visible");
  expect(
    Array.from(container.querySelectorAll<HTMLSelectElement>(".session-log-filters select"))[1]
      ?.textContent,
  ).toContain("exec");
  const reset = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === "Reset",
  );
  reset?.click();
  flush();
  expect(container.querySelector(".session-summary-value")?.textContent).toBe("10");
  expect(container.textContent).toContain("Deselected May 14");
  expect(container.querySelector(".session-logs-header-count")?.textContent).not.toContain("of");
});

it("aggregates selected tokens while counting actual loaded message roles", () => {
  const start = Date.parse("2026-08-20T12:00:00Z");
  const end = start + 1000;
  const points = [
    point({ timestamp: start, input: 10, output: 0, cacheRead: 5, cacheWrite: 2 }),
    point({
      timestamp: end,
      totalTokens: 200,
      cost: 0.2,
      input: 0,
      output: 20,
      cacheRead: 7,
      cacheWrite: 3,
    }),
    point({ timestamp: end + 1000, totalTokens: 300, cost: 0.3 }),
  ];
  const entry = session();
  entry.usage.messageCounts = { ...entry.usage.messageCounts!, toolResults: 4, errors: 2 };
  entry.usage.toolUsage = toolUsage();
  const logs: SessionLogEntry[] = [
    log(start - 1000, "user", "Earlier request"),
    log(0, "user", "Undated request"),
    log(start, "assistant", "[Tool: read]"),
    log(start + 250, "toolResult", "First result"),
    log(start + 500, "assistant", "Unmetered update"),
    log(start + 750, "tool", "Second result"),
    log(end, "assistant", "Finished"),
  ];
  const data = { session: entry, sessionLogsData: logs, sessionLogsHasLoaded: true };
  const container = mount(points, { start, end, breakdownMode: "by-type", ...data });

  expectText(container, ".session-detail-stats", "300", "$0.30");
  expect(container.querySelector(".session-detail-indicator")).not.toBeNull();
  expect(summary(container)).toMatchObject([
    { value: "3", meta: "0 user · 3 assistant Loaded conversation · selected interval" },
    {},
    { value: "—", meta: "— tool results" },
    { value: "1s" },
  ]);
  const breakdown = texts(container, ".timeseries-breakdown .legend-item").map((value) =>
    value?.replaceAll(/\s+/g, " "),
  );
  expect(breakdown).toEqual(["Output 20", "Input 10", "Cache Write 5", "Cache Read 12"]);
  expect(text(container, ".timeseries-breakdown .cost-breakdown-total")).toContain("47");

  const full = mount(points, data);
  expect(summary(full)).toMatchObject([
    { value: "10", meta: "5 user · 5 assistant" },
    { value: "7", meta: "2 tools used" },
    { value: "2", meta: "4 tool results" },
    {},
  ]);
  expect(toolRows(full)).toEqual([
    ["read", "4"],
    ["exec", "3"],
  ]);
});

it("keeps interval message and tool counts unavailable for initial failure", () => {
  const start = Date.parse("2026-08-20T12:00:00Z");
  const entry = session();
  entry.usage.toolUsage = toolUsage();
  const container = mount([point({ timestamp: start }), point({ timestamp: start + 1000 })], {
    start,
    end: start + 1000,
    session: entry,
    sessionLogsData: null,
    sessionLogsHasLoaded: false,
    sessionLogs: "logs unavailable",
  });
  expect(summary(container)).toMatchObject([
    { value: "—", meta: "— Loaded conversation · selected interval" },
    { value: "—", meta: "— tools used" },
    {},
    {},
  ]);
  expect(toolRows(container)).toEqual([
    ["read", "—"],
    ["exec", "—"],
  ]);
});

it("keeps stale loaded counts independent of conversation search and role filters", () => {
  const start = Date.parse("2026-08-20T12:00:00Z");
  const container = mount([point({ timestamp: start }), point({ timestamp: start + 1000 })], {
    start,
    end: start + 1000,
    sessionLogsData: [log(start, "user", "Question"), log(start + 1000, "assistant", "Answer")],
    sessionLogsHasLoaded: true,
    sessionLogs: "refresh failed",
    stale: true,
    logFilters: { roles: ["tool"], tools: [], hasTools: false, query: "not present" },
  });
  expect(summary(container)).toMatchObject([
    { value: "2", meta: "1 user · 1 assistant Loaded conversation · selected interval" },
    { value: "0" },
    {},
    {},
  ]);
  expect(container.querySelectorAll(".session-log-entry")).toHaveLength(0);
  expect(text(container, ".usage-detail-error--conversation")).toContain("Showing stale data");
});

it("counts repeated assistant calls without counting toolResult results in the selected range", () => {
  const start = Date.parse("2026-08-20T12:00:00Z");
  const end = start + 2000;
  const entry = session();
  entry.usage.toolUsage = toolUsage(1, 1);
  const logs: SessionLogEntry[] = [
    log(start, "assistant", "[Tool: read]\n[Tool: read]"),
    log(start + 500, "toolResult", "[Tool: read]\n[Tool Result]\nFirst file"),
    log(start + 1000, "toolResult", "[Tool: read]\n[Tool Result]\nSecond file"),
    log(end, "assistant", "Both files reviewed."),
    log(end + 1000, "assistant", "[Tool: exec]"),
    log(0, "assistant", "[Tool: exec]"),
  ];
  const points = [start, end, end + 1000].map((timestamp) => point({ timestamp }));
  const data = { session: entry, sessionLogsData: logs, sessionLogsHasLoaded: true };
  const selected = mount(points, { start, end, ...data });
  expect(summary(selected)[1]).toMatchObject({ value: "2", meta: "1 tools used" });
  expect(toolRows(selected)).toEqual([
    ["read", "2"],
    ["exec", "0"],
  ]);
  expect(text(selected, ".session-log-tools-pill")?.trim()).toBe("read × 2");
  expect(texts(selected, ".session-log-tools-pill").map((value) => value?.trim())).toContain(
    "exec × 1",
  );
});

it("accepts a reversed range and falls back to full totals when no points match", () => {
  const reversed = mount(
    [point({ timestamp: 1000, totalTokens: 50 }), point({ timestamp: 2000, totalTokens: 75 })],
    { start: 2000, end: 1000 },
  );
  expect(reversed.querySelector(".session-detail-stats")?.textContent).toContain("125");

  const empty = mount([point({ timestamp: 1000 })], { start: 3000, end: 4000 });
  expect(empty.querySelector(".session-detail-stats")?.textContent).toContain("1.0K");
  expect(empty.querySelector(".session-detail-indicator")).toBeNull();
});

it("never renders Invalid Date for out-of-range point timestamps", () => {
  const container = mount([
    point({ timestamp: 8_640_000_000_000_001 }),
    point({ timestamp: 8_640_000_000_000_002 }),
  ]);
  expect(container.textContent).not.toContain("Invalid Date");
});

it("renders detail request failure messages without retry buttons", () => {
  const container = mount([], {
    timeSeries: "timeline unavailable",
    sessionLogs: "logs unavailable",
  });

  for (const [kind, message] of [
    ["timeline", "Could not load usage over time: timeline unavailable"],
    ["conversation", "Could not load conversation: logs unavailable"],
  ]) {
    const error = container.querySelector(`.usage-detail-error--${kind}`);
    expect(error?.textContent).toContain(message);
    expect(error?.querySelector("button")).toBeNull();
  }
});

it("keeps loaded details visible and marks them stale after refresh failures", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const timestamp = Date.UTC(2026, 0, 2, 15, 4, 55);
  try {
    for (const locale of ["en", "fr", "en"] as const) {
      await i18n.setLocale(locale);
      const container = mount([point({ timestamp: 1000 }), point({ timestamp: 2000 })], {
        timeSeries: "timeline unavailable",
        sessionLogs: "logs unavailable",
        sessionLogsData: [
          log(timestamp, "user", "retained message"),
          log(Number.NaN, "assistant", "undated message"),
        ],
        stale: true,
      });

      expect(container.querySelectorAll(".usage-detail-error--timeline strong")).toHaveLength(1);
      expect(container.querySelectorAll(".usage-detail-error--conversation strong")).toHaveLength(
        1,
      );
      expect(container.querySelector(".timeseries-svg")).not.toBeNull();
      expect(container.textContent).toContain("retained message");
      expect(container.textContent).toContain("undated message");
      expect(container.textContent).toContain(
        locale === "en" ? "Showing stale data" : t("common.staleData"),
      );
      const timestamps = [...container.querySelectorAll(".session-log-meta > span:nth-child(2)")];
      expect(timestamps.map((element) => element.textContent)).toEqual([
        new Date(timestamp).toLocaleString(locale, {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
        t("common.na"),
      ]);
    }
  } finally {
    await restoreI18n();
  }
});

it("counts embedded context once with an unverified native file", () => {
  const contextWeight: NonNullable<UsageSessionEntry["contextWeight"]> = {
    source: "run",
    generatedAt: 0,
    systemPrompt: { chars: 1000, projectContextChars: 200, nonProjectContextChars: 800 },
    skills: { promptChars: 200, entries: [{ name: "synthetic-skill", blockChars: 200 }] },
    tools: {
      listChars: 100,
      schemaChars: 300,
      entries: [{ name: "synthetic-tool", summaryChars: 100, schemaChars: 300 }],
    },
    injectedWorkspaceFiles: [contextFile("known.md", 200), contextFile("AGENTS.md", 900, true)],
  };
  const container = mount([], { contextWeight });
  expect(text(container, ".context-total")).toContain("325");
  expect(
    texts(container, ".context-legend .legend-item").map((value) => value?.replaceAll(/\s+/g, " ")),
  ).toEqual(["Sys ~125", "Skills ~50", "Tools ~100", "Files ~50"]);
  const fileRows = container.querySelectorAll(
    ".context-breakdown-card:last-child .context-breakdown-item",
  );
  expect(fileRows).toHaveLength(2);
  expect(fileRows[1]?.textContent).toContain("AGENTS.md");
  expect(fileRows[1]?.querySelector(".muted")?.textContent).toBe("unknown");
});

it("preserves context-category order, sorted cards, expansion, and callbacks", () => {
  const contextWeight: NonNullable<UsageSessionEntry["contextWeight"]> = {
    source: "run",
    generatedAt: 0,
    systemPrompt: { chars: 80, projectContextChars: 20, nonProjectContextChars: 60 },
    skills: {
      promptChars: 100,
      entries: Array.from({ length: 5 }, (_, index) => ({
        name: `skill-${index}`,
        blockChars: (index + 1) * 10,
      })),
    },
    tools: {
      listChars: 20,
      schemaChars: 30,
      entries: [
        { name: "smaller-tool", summaryChars: 4, schemaChars: 6 },
        { name: "larger-tool", summaryChars: 8, schemaChars: 12 },
      ],
    },
    injectedWorkspaceFiles: [
      contextFile("small.md", 10),
      contextFile("large.md", 30),
      contextFile("AGENTS.md", 100, true),
    ],
  };
  const onToggleContextExpanded = vi.fn();
  const container = mount([], { contextWeight, onToggleContextExpanded });
  const categories = ["system", "skills", "tools", "files"];

  expect(
    [...container.querySelectorAll(".context-stacked-bar .context-segment")].map((segment) =>
      categories.find((category) => segment.classList.contains(category)),
    ),
  ).toEqual(categories);
  const cards = [...container.querySelectorAll(".context-breakdown-card")];
  expect(texts(container, ".context-breakdown-title").map((value) => value?.trim())).toEqual([
    "Skills (5)",
    "Tools (2)",
    "Files (3)",
  ]);
  expect(texts(cards[0]!, ".context-breakdown-item .mono")).toEqual([
    "skill-4",
    "skill-3",
    "skill-2",
    "skill-1",
  ]);
  expect(text(cards[1], ".context-breakdown-item .mono")).toBe("larger-tool");
  const fileEntries = [...(cards[2]?.querySelectorAll(".context-breakdown-item") ?? [])];
  expect(fileEntries.map((entry) => text(entry, ".mono"))).toEqual([
    "large.md",
    "small.md",
    "AGENTS.md",
  ]);
  expect(text(fileEntries[2], ".muted")).toBe("unknown");
  expect(text(cards[0], ".context-breakdown-more")).toContain("1 more");
  document.body.append(container);
  const toggle = container.querySelector<HTMLButtonElement>(".context-breakdown-header button")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus();
  toggle.click();
  flush();
  expect(onToggleContextExpanded).toHaveBeenCalledOnce();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".context-breakdown-header button")).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(
    container
      .querySelectorAll(".context-breakdown-card")[0]
      ?.querySelectorAll(".context-breakdown-item"),
  ).toHaveLength(5);
  expect(container.querySelector(".context-breakdown-more")).toBeNull();

  toggle.click();
  flush();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
  expect(cards[0]?.querySelectorAll(".context-breakdown-item")).toHaveLength(4);
  expect(cards[0]?.querySelector(".context-breakdown-more")?.textContent).toContain("1 more");
});
