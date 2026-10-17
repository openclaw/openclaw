import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageAggregates, UsageProps, UsageSessionEntry } from "./types.ts";
import { totals, dailyEntry } from "./usage-chart.test-support.ts";
import { renderCostWindowComparison, renderFilterChips, UsageInsights } from "./view-overview.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";
import { createUsageOverview, createUsageProps } from "./view.test-support.ts";

const aggregates = {
  messages: {
    total: 4,
    user: 2,
    assistant: 2,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
  tools: {
    totalCalls: 0,
    uniqueTools: 0,
    tools: [],
  },
  byModel: [],
  byProvider: [],
  byAgent: [],
  byChannel: [],
  daily: [],
} as unknown as UsageAggregates;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UsageInsights", () => {
  it("renders overview hints as focusable tooltip anchors and identifies agents in the breakdown", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const [currentTotals, setCurrentTotals] = createSignal(totals);
    const [currentAggregates, setCurrentAggregates] = createSignal({
      ...aggregates,
      byAgent: [
        { agentId: "main", totals },
        { agentId: "research", totals },
      ],
    });

    mountSolid(
      () =>
        UsageInsights({
          get totals() {
            return currentTotals();
          },
          get aggregates() {
            return currentAggregates();
          },
          stats: {
            durationCount: 0,
            avgDurationMs: 0,
            errorRate: 0,
          },
          showCostHint: false,
          showCostShares: true,
          errorHours: [],
          sessionCount: 1,
          totalSessions: 1,
        }),
      { container },
    );
    flush();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.usage-summary-hint")];
    const cacheCard = container
      .querySelector("#usage-summary-hint-cache-hit-rate")
      ?.closest(".usage-summary-card");
    expect(cacheCard?.querySelector(".usage-summary-value")?.textContent).toBe("30.0%");
    expect(cacheCard?.querySelector(".usage-summary-sub")?.textContent).toBe(
      "300 cached · 1.0K prompt",
    );
    const tooltips = [...container.querySelectorAll("openclaw-tooltip")];
    expect(buttons).toHaveLength(9);
    expect(tooltips).toHaveLength(9);
    expect(
      [...container.querySelectorAll(".usage-list-item .agent-row-chip")].map((chip) =>
        chip.getAttribute("data-agent-id"),
      ),
    ).toEqual(["main", "research"]);
    expect(
      buttons.every(
        (button) =>
          button.type === "button" &&
          !button.hasAttribute("title") &&
          Boolean(button.getAttribute("aria-label")),
      ),
    ).toBe(true);
    expect(
      tooltips.every((tooltip) => {
        const button = tooltip.querySelector<HTMLButtonElement>("button.usage-summary-hint");
        const content = tooltip.querySelector('[slot="content"]');
        return Boolean(
          button &&
          buttons.includes(button) &&
          content &&
          button.getAttribute("aria-label") !== content.textContent,
        );
      }),
    ).toBe(true);

    await Promise.all(tooltips.map((tooltip) => tooltip.updateComplete));
    const button = buttons[0]!;
    const tooltip = button.closest("openclaw-tooltip")!;
    button.click();
    await tooltip.updateComplete;
    const popup = tooltip.shadowRoot?.querySelector(".tooltip-surface[popover]");
    expect(popup).toBeTruthy();
    expect(document.activeElement).toBe(button);

    setCurrentTotals((current) => ({ ...current, totalCost: 12 }));
    setCurrentAggregates((current) => ({
      ...current,
      messages: { ...current.messages, total: 8 },
    }));
    flush();
    expect(container.querySelector("#usage-summary-hint-messages")).toBe(button);
    expect(button.closest("openclaw-tooltip")).toBe(tooltip);
    expect(tooltip.shadowRoot?.querySelector(".tooltip-surface[popover]")).toBe(popup);
    expect(document.activeElement).toBe(button);
    expect(
      button.closest(".usage-summary-card")?.querySelector(".usage-summary-value")?.textContent,
    ).toBe("8");
  });
});

describe("usage overview presentation owners", () => {
  it("preserves filter-chip order, session-only title, labels, and clear callbacks", () => {
    const container = document.createElement("div");
    const onClearDays = vi.fn();
    const onClearHours = vi.fn();
    const onClearSessions = vi.fn();
    const props = createUsageProps();
    Object.assign(props.filters, {
      selectedDays: ["2026-08-01"],
      selectedHours: [8],
      selectedSessions: ["agent:main:usage"],
    });
    Object.assign(props.callbacks.filters, { onClearDays, onClearHours, onClearSessions });
    mountSolid(
      () =>
        renderFilterChips(
          [{ key: "agent:main:usage", label: "Usage thread" } as UsageSessionEntry],
          props,
        ),
      { container },
    );
    flush();

    const chips = [...container.querySelectorAll<HTMLElement>(".filter-chip")];
    expect(chips.map((chip) => chip.querySelector("button")?.getAttribute("aria-label"))).toEqual([
      "Remove days filter",
      "Remove hours filter",
      "Remove session filter",
    ]);
    expect(chips.map((chip) => chip.getAttribute("title"))).toEqual([null, null, "Usage thread"]);
    chips.forEach((chip) => chip.querySelector<HTMLButtonElement>("button")?.click());
    expect(onClearDays).toHaveBeenCalledOnce();
    expect(onClearHours).toHaveBeenCalledOnce();
    expect(onClearSessions).toHaveBeenCalledOnce();
  });
});

describe("renderCostWindowComparison", () => {
  it("preserves sub-cent totals and daily averages", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderCostWindowComparison(
          [dailyEntry("2026-07-01", 300, 0.003)],
          "2026-06-02",
          "2026-07-01",
          "local",
        ),
      { container },
    );
    flush();

    const range = container.querySelector(".cost-window--range");
    expect(range?.querySelector(".cost-window__value")?.textContent?.trim()).toBe("$0.0030");
    expect(range?.querySelector(".cost-window__meta")?.textContent).toContain("$0.0001 / day");
  });
});

describe("SessionsCard", () => {
  const session = (key: string, tokens = 100): UsageSessionEntry => ({
    key,
    label: key,
    agentId: "main",
    usage: { ...totals, totalTokens: tokens },
  });

  it("preserves sort focus while waiting for the server to reorder rows", () => {
    const base = createUsageProps();
    const [display, setDisplay] = createSignal(base.display);
    const [sessions, setSessions] = createSignal([session("Alpha"), session("Beta")]);
    const onChange = vi.fn((patch: Partial<UsageProps["display"]>) =>
      setDisplay((current) => ({ ...current, ...patch })),
    );
    const usage = {
      ...base,
      get display() {
        return display();
      },
      callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onChange } },
    };
    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        SessionsCard({
          get sessions() {
            return sessions();
          },
          usage,
          totalSessions: 2,
        }),
      { container },
    );
    flush();
    const select = container.querySelector<HTMLSelectElement>(".sessions-sort select")!;
    select.focus();
    select.value = "cost";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(onChange).toHaveBeenCalledWith({ sessionSort: "cost" });
    expect(container.querySelector(".session-bar-title")?.textContent).toBe("Alpha");
    setSessions([session("Beta"), session("Alpha")]);
    flush();
    expect(container.querySelector(".session-bar-title")?.textContent).toBe("Beta");
    expect(container.querySelector(".sessions-sort select")).toBe(select);
    expect(document.activeElement).toBe(select);
  });

  it("updates retained rows and shift selection across selection, mode, and roster changes", () => {
    const base = createUsageProps();
    const [display, setDisplay] = createSignal(base.display);
    const [filters, setFilters] = createSignal(base.filters);
    const [sessions, setSessions] = createSignal([session("Alpha"), session("Beta")]);
    const onSelectSession = vi.fn();
    const usage = {
      ...base,
      get display() {
        return display();
      },
      get filters() {
        return filters();
      },
      get data() {
        return { ...base.data, overview: createUsageOverview({ selectedRows: sessions() }) };
      },
      callbacks: { ...base.callbacks, details: { ...base.callbacks.details, onSelectSession } },
    };
    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        SessionsCard({
          get sessions() {
            return sessions();
          },
          usage,
          totalSessions: 2,
        }),
      { container },
    );
    flush();
    const first = container.querySelector<HTMLButtonElement>(".session-bar-selection")!;
    first.focus();

    setFilters({ ...base.filters, selectedSessions: ["Alpha"] });
    setDisplay({ ...base.display, chartMode: "cost" });
    flush();
    expect(container.querySelector(".session-bar-selection")).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    const values = [...container.querySelectorAll(".session-bar-value")];
    expect(values).toHaveLength(4);
    expect(values.every((value) => value.textContent?.startsWith("$"))).toBe(true);

    setSessions([session("Beta"), { ...session("Alpha", 250), label: "Renamed", channel: "web" }]);
    setDisplay(base.display);
    flush();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".session-bar-selection")];
    expect(buttons[1]).toBe(first);
    expect(first.querySelector(".session-bar-title")?.textContent).toBe("Renamed");
    expect(first.querySelector(".session-bar-meta")?.textContent).toContain("web");
    expect(
      first.closest(".session-bar-row")?.querySelector(".session-bar-value")?.textContent,
    ).toBe("250");
    first.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectSession).toHaveBeenLastCalledWith("Alpha", true, ["Beta", "Alpha"]);
  });

  it("keeps metadata and lower-bound usage labels localized without replacing a row", async () => {
    const restoreI18n = captureI18nStateForTesting();
    const entry = session("Alpha");
    const sessionUsage = entry.usage!;
    sessionUsage.durationMs = 60_000;
    sessionUsage.usageReport = { state: "unavailable" };
    const base = createUsageProps();
    const [display, setDisplay] = createSignal(base.display);
    const usage = {
      ...base,
      get display() {
        return display();
      },
    };
    const overview = createUsageOverview({
      total: 1,
      tableSessionCount: 1,
      tableTotals: {
        tokens: sessionUsage.totalTokens,
        cost: sessionUsage.totalCost,
        errors: 0,
        usageReport: sessionUsage.usageReport,
      },
    });
    const container = document.createElement("div");
    try {
      await i18n.setLocale("en");
      mountSolid(() => SessionsCard({ sessions: [entry], usage, overview, totalSessions: 1 }), {
        container,
      });
      flush();
      const row = container.querySelector(".session-bar-row");
      const value = () => row?.querySelector(".session-bar-value")?.textContent;
      const average = () => container.querySelector(".sessions-card-stats > span")?.textContent;
      expect(row?.querySelector(".session-bar-meta")?.textContent).toContain("1m");
      // A response that ended before final usage leaves its subtotal as a lower bound.
      const atLeast = (amount: string) => t("usage.common.atLeast", { value: amount });
      expect(value()).toBe(atLeast("100"));
      expect(value()).toBe("≥ 100");
      expect(average()).toBe(`${atLeast("100")} ${t("usage.sessions.avg")}`);
      await i18n.setLocale("de");
      flush();
      expect(container.querySelector(".session-bar-row")).toBe(row);
      const germanMinute = new Intl.NumberFormat("de", {
        style: "unit",
        unit: "minute",
        unitDisplay: "narrow",
      }).format(1);
      expect(row?.querySelector(".session-bar-meta")?.textContent).toContain(germanMinute);
      expect(value()).toBe(atLeast("100"));
      expect(average()).toBe(`${atLeast("100")} ${t("usage.sessions.avg")}`);
      expect(t("usage.sessions.avg")).not.toBe("avg");
      setDisplay({ ...base.display, chartMode: "cost" });
      flush();
      expect(value()).toBe(atLeast("$0.00"));
      await i18n.setLocale("en");
      flush();
      expect(container.querySelector(".session-bar-row")).toBe(row);
      expect(value()).toBe("≥ $0.00");
      expect(average()).toBe("≥ $0.00 avg");
    } finally {
      await restoreI18n();
    }
  });

  it("renders the server recent roster without changing its all-roster average", () => {
    const base = createUsageProps();
    const overview = createUsageOverview({
      total: 2,
      tableSessionCount: 100,
      tableTotals: { tokens: 50000, cost: 100, errors: 7 },
    });
    const usage = {
      ...base,
      data: { ...base.data, overview },
      display: {
        ...base.display,
        sessionsTab: "recent" as const,
        recentSessions: ["A", "missing"],
      },
    };
    const container = document.createElement("div");
    mountSolid(
      () =>
        SessionsCard({ sessions: [session("B"), session("A")], usage, overview, totalSessions: 2 }),
      { container },
    );
    flush();
    expect(
      [...container.querySelectorAll(".session-bar-title")].map((entry) => entry.textContent),
    ).toEqual(["B", "A"]);
    expect(container.querySelector(".sessions-card-stats")?.textContent).toContain("500 avg");
  });
});
