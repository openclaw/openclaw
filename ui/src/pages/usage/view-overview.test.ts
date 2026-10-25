import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageAggregates, UsageProps, UsageSessionEntry, UsageTotals } from "./types.ts";
import { totals, dailyEntry } from "./usage-chart.test-support.ts";
import { renderCostWindowComparison, renderFilterChips, UsageInsights } from "./view-overview.tsx";
import { mountView, text, texts, usageState } from "./view-render.test-support.ts";
import { SessionsCard } from "./view-sessions-card.tsx";
import {
  buildAggregatesFromSessions,
  createUsageOverview,
  usageFixture,
} from "./view.test-support.ts";

const aggregates = buildAggregatesFromSessions([]);
Object.assign(aggregates.messages, { total: 4, user: 2, assistant: 2 });

function mountInsights(currentTotals: () => UsageTotals, currentAggregates: () => UsageAggregates) {
  return mountView(() =>
    UsageInsights({
      get totals() {
        return currentTotals();
      },
      get aggregates() {
        return currentAggregates();
      },
      stats: { durationCount: 0, avgDurationMs: 0, errorRate: 0 },
      showCostHint: false,
      errorHours: [],
      sessionCount: 1,
      totalSessions: 1,
    }),
  );
}

describe("UsageInsights", () => {
  it("renders overview hints as focusable tooltip anchors and identifies agents in the breakdown", async () => {
    const [currentTotals, setCurrentTotals] = createSignal(totals);
    const [currentAggregates, setCurrentAggregates] = createSignal({
      ...aggregates,
      byAgent: [
        { agentId: "main", totals },
        { agentId: "research", totals },
      ],
    });

    const { container } = mountInsights(currentTotals, currentAggregates);

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.usage-summary-hint")];
    const cacheCard = container
      .querySelector("#usage-summary-hint-cache-hit-rate")
      ?.closest(".usage-summary-card");
    expect(text(cacheCard, ".usage-summary-value")).toBe("30.0%");
    expect(text(cacheCard, ".usage-summary-sub")).toBe("300 cached · 1.0K prompt");
    const tooltips = [...container.querySelectorAll("openclaw-tooltip")];
    expect(buttons).toHaveLength(9);
    expect(tooltips).toHaveLength(9);
    expect(
      [...container.querySelectorAll(".usage-list-item .agent-row-chip")].map((chip) =>
        chip.getAttribute("data-agent-id"),
      ),
    ).toEqual(["main", "research"]);
    for (const button of buttons) {
      expect([
        button.type,
        button.hasAttribute("title"),
        Boolean(button.getAttribute("aria-label")),
      ]).toEqual(["button", false, true]);
    }
    for (const tooltip of tooltips) {
      const button = tooltip.querySelector<HTMLButtonElement>("button.usage-summary-hint");
      const content = tooltip.querySelector('[slot="content"]');
      expect(buttons).toContain(button);
      expect(content).not.toBeNull();
      expect(button?.getAttribute("aria-label")).not.toBe(content?.textContent);
    }

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
    expect(text(button.closest(".usage-summary-card"), ".usage-summary-value")).toBe("8");
  });
  it("hides cost shares while the overall total is a lower bound", () => {
    const complete = { ...totals, totalCost: 10 };
    const partialTotals = { ...complete, usageReport: { state: "unavailable" as const } };
    const { container } = mountInsights(
      () => partialTotals,
      () => ({ ...aggregates, byProvider: [{ provider: "openai", count: 1, totals: complete }] }),
    );
    // A complete provider's share of an incomplete total is unknown, not 100%.
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).not.toContain("of cost");
  });

  it("labels usage without a known price as unpriced, never free", () => {
    const unpriced = { ...totals, totalCost: 0, missingCostEntries: 3 };
    const { container } = mountInsights(
      () => unpriced,
      () => ({ ...aggregates, byProvider: [{ provider: "ollama", count: 1, totals: unpriced }] }),
    );
    const provider = [...container.querySelectorAll(".usage-list-item")].find((item) =>
      item.textContent?.toLowerCase().includes("ollama"),
    );
    expect(text(provider, ".usage-list-value")).toContain("Unpriced");
    expect(provider?.textContent).not.toContain("$0.00");
  });

  it("names the provider of each top model so same-named models stay distinct", () => {
    const container = document.createElement("div");
    const used = { ...totals, totalTokens: 100, totalCost: 1 };
    mountSolid(
      () =>
        UsageInsights({
          totals: used,
          aggregates: {
            ...aggregates,
            byModel: [
              { provider: "anthropic", model: "claude-opus-5.5", count: 2, totals: used },
              { provider: "github-copilot", model: "claude-opus-5.5", count: 1, totals: used },
            ],
          },
          stats: { durationCount: 0, avgDurationMs: 0, errorRate: 0 },
          showCostHint: false,
          errorHours: [],
          sessionCount: 1,
          totalSessions: 1,
        }),
      { container },
    );
    flush();
    const subs = [...container.querySelectorAll(".usage-list-item")]
      .filter((item) => item.querySelector(".usage-list-label")?.textContent === "claude-opus-5.5")
      .map((item) => item.querySelector(".usage-list-sub")?.textContent ?? "");
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatch(/^Anthropic · /u);
    expect(subs[1]).not.toMatch(/^Anthropic · /u);
  });
});

it("preserves filter-chip order, session-only title, labels, and clear callbacks", () => {
  const onClearDays = vi.fn();
  const onClearHours = vi.fn();
  const onClearSessions = vi.fn();
  const props = usageFixture(
    {},
    {
      selectedDays: ["2026-08-01"],
      selectedHours: [8],
      selectedSessions: ["agent:main:usage"],
    },
  );
  Object.assign(props.callbacks.filters, { onClearDays, onClearHours, onClearSessions });
  const { container } = mountView(() =>
    renderFilterChips(
      [{ key: "agent:main:usage", label: "Usage thread" } as UsageSessionEntry],
      props,
    ),
  );

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

it.each([false, true])(
  "cost windows preserve sub-cent totals and daily completeness (partial: %s)",
  (partial) => {
    const day = dailyEntry("2026-07-01", 300, 0.003);
    if (partial) {
      day.usageReport = { state: "unavailable" };
    }
    const { container } = mountView(() =>
      renderCostWindowComparison([day], "2026-06-02", "2026-07-01", "local"),
    );

    const range = container.querySelector(".cost-window--range");
    const prefix = partial ? "≥ " : "";
    expect(text(range, ".cost-window__value")?.trim()).toBe(`${prefix}$0.0030`);
    expect(text(range, ".cost-window__meta")).toContain(`${prefix}$0.0001 / day`);
    range!
      .querySelector(".usage-bars__bar:last-of-type")!
      .dispatchEvent(new MouseEvent("pointerenter"));
    flush();
    expect(text(range, ".usage-bars__tip")).toBe(`Jul 1 · ${prefix}$0.0030`);
  },
);

describe("SessionsCard", () => {
  const session = (key: string, tokens = 100): UsageSessionEntry => ({
    key,
    label: key,
    agentId: "main",
    usage: { ...totals, totalTokens: tokens },
  });
  const mountSessions = (
    sessions: () => UsageSessionEntry[],
    usage: UsageProps,
    totalSessions = 2,
    overview?: UsageProps["data"]["sessionPage"],
  ) =>
    mountView(() =>
      SessionsCard({
        get sessions() {
          return sessions();
        },
        usage,
        totalSessions,
        overview,
      }),
    );

  it("exposes the selected session view to assistive technology", () => {
    const { usage, onChange } = usageState();
    const view = mountSessions(() => [], usage, 0);

    const all = view.getByRole<HTMLButtonElement>("button", { name: "All", pressed: true });
    const recent = view.getByRole<HTMLButtonElement>("button", {
      name: "Recently viewed",
      pressed: false,
    });
    recent.click();
    flush();
    expect(onChange).toHaveBeenLastCalledWith({ sessionsTab: "recent" });
    expect(view.getByRole("button", { name: "Recently viewed", pressed: true })).toBe(recent);
    expect(view.getByRole("button", { name: "All", pressed: false })).toBe(all);

    all.click();
    flush();
    expect(onChange).toHaveBeenLastCalledWith({ sessionsTab: "all" });
    expect(view.getByRole("button", { name: "All", pressed: true })).toBe(all);
    expect(view.getByRole("button", { name: "Recently viewed", pressed: false })).toBe(recent);
  });

  it("preserves sort focus while waiting for the server to reorder rows", () => {
    const { usage, onChange } = usageState();
    const [sessions, setSessions] = createSignal([session("Alpha"), session("Beta")]);
    const { container } = mountSessions(sessions, usage);
    const select = container.querySelector<HTMLSelectElement>(".sessions-sort select")!;
    select.focus();
    select.value = "cost";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(onChange).toHaveBeenCalledWith({ sessionSort: "cost" });
    expect(text(container, ".session-bar-title")).toBe("Alpha");
    setSessions([session("Beta"), session("Alpha")]);
    flush();
    expect(text(container, ".session-bar-title")).toBe("Beta");
    expect(container.querySelector(".sessions-sort select")).toBe(select);
    expect(document.activeElement).toBe(select);
  });

  it("updates retained rows and shift selection across selection, mode, and roster changes", () => {
    const [sessions, setSessions] = createSignal([session("Alpha"), session("Beta")]);
    const { base, usage, setDisplay, setFilters } = usageState({}, (data) => ({
      ...data,
      overview: createUsageOverview({ selectedRows: sessions() }),
    }));
    const onSelectSession = vi.fn();
    usage.callbacks.details.onSelectSession = onSelectSession;
    const { container } = mountSessions(sessions, usage);
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
    expect(text(first, ".session-bar-title")).toBe("Renamed");
    expect(text(first, ".session-bar-meta")).toContain("web");
    expect(text(first.closest(".session-bar-row"), ".session-bar-value")).toBe("250");
    first.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectSession).toHaveBeenLastCalledWith("Alpha", true, ["Beta", "Alpha"]);
  });

  it("keeps metadata and lower-bound usage labels localized without replacing a row", async () => {
    const restoreI18n = captureI18nStateForTesting();
    const entry = session("Alpha");
    const sessionUsage = entry.usage!;
    sessionUsage.durationMs = 60_000;
    sessionUsage.usageReport = { state: "unavailable" };
    const { base, usage, setDisplay } = usageState();
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
    try {
      await i18n.setLocale("en");
      const { container } = mountView(() =>
        SessionsCard({ sessions: [entry], usage, overview, totalSessions: 1 }),
      );
      const row = container.querySelector(".session-bar-row");
      const value = () => text(row, ".session-bar-value");
      const average = () => text(container, ".sessions-card-stats > span");
      expect(text(row, ".session-bar-meta")).toContain("1m");
      expect(value()).toMatch(/^≥ \d/);
      expect(average()).toMatch(/^≥ /);
      const englishValue = value();
      await i18n.setLocale("de");
      flush();
      expect(container.querySelector(".session-bar-row")).toBe(row);
      const germanMinute = new Intl.NumberFormat("de", {
        style: "unit",
        unit: "minute",
        unitDisplay: "narrow",
      }).format(1);
      expect(text(row, ".session-bar-meta")).toContain(germanMinute);
      expect(value()).toBe(englishValue);
      expect(average()).toMatch(/^≥ /);
      setDisplay({ ...base.display, chartMode: "cost" });
      flush();
      expect(value()).toBe("≥ $0.00");
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
    const overview = createUsageOverview({
      total: 2,
      tableSessionCount: 100,
      tableTotals: { tokens: 50000, cost: 100, errors: 7 },
    });
    const usage = usageFixture(
      { overview },
      {},
      {
        sessionsTab: "recent",
        recentSessions: ["A", "missing"],
      },
    );
    const { container } = mountView(() =>
      SessionsCard({ sessions: [session("B"), session("A")], usage, overview, totalSessions: 2 }),
    );
    expect(texts(container, ".session-bar-title", false)).toEqual(["B", "A"]);
    expect(text(container, ".sessions-card-stats")).toContain("500 avg");
  });

  it("leads with the top ten sessions and expands to the full page on request", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => session(`S${index + 1}`));
    const overview = createUsageOverview({ total: 12, tableSessionCount: 12 });
    const { container } = mountSessions(() => sessions, usageFixture({ overview }), 12, overview);
    const rows = () => container.querySelectorAll(".session-bar-row").length;
    expect(rows()).toBe(10);
    const toggle = container.querySelector<HTMLButtonElement>(".sessions-show-all")!;
    expect(toggle.textContent?.trim()).toBe("Show all 12");
    toggle.click();
    flush();
    expect(rows()).toBe(12);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
