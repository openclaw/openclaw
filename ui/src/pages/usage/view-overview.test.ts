import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageAggregates, UsageProps, UsageSessionEntry } from "./types.ts";
import { totals, dailyEntry } from "./usage-chart.test-support.ts";
import { CostBreakdownCompact } from "./view-chart.tsx";
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

function directText(element: Element | null | undefined): string | undefined {
  return Array.from(element?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function getSummaryCards(container: HTMLElement): Array<{
  title: string | undefined;
  value: string | undefined;
  sub: string | undefined;
}> {
  return Array.from(container.querySelectorAll(".usage-summary-card")).map((card) => ({
    title: directText(card.querySelector(".usage-summary-title")),
    value: card.querySelector(".usage-summary-value")?.textContent?.trim(),
    sub: card.querySelector(".usage-summary-sub")?.textContent?.trim(),
  }));
}

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
    const tooltips = [...container.querySelectorAll("openclaw-tooltip")];
    expect(buttons).toHaveLength(9);
    expect(tooltips).toHaveLength(9);
    await Promise.all(
      [...container.querySelectorAll("openclaw-agent-row-chip")].map((chip) => chip.updateComplete),
    );
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
    const popup = tooltip.shadowRoot?.querySelector("wa-tooltip");
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
    expect(tooltip.shadowRoot?.querySelector("wa-tooltip")).toBe(popup);
    expect(document.activeElement).toBe(button);
    expect(
      button.closest(".usage-summary-card")?.querySelector(".usage-summary-value")?.textContent,
    ).toBe("8");
  });

  it("includes cache writes in cache-hit-rate denominator", () => {
    const container = document.createElement("div");

    mountSolid(
      () =>
        UsageInsights({
          totals,
          aggregates,
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

    expect(getSummaryCards(container).filter((card) => card.title === "Cache Hit Rate")).toEqual([
      {
        title: "Cache Hit Rate",
        value: "30.0%",
        sub: "300 cached · 1.0K prompt",
      },
    ]);
  });

  it("shows provider cost share when cost data is available", () => {
    const container = document.createElement("div");
    const costTotals = { ...totals, totalCost: 10 };
    const costAggregates = {
      ...aggregates,
      byProvider: [
        {
          provider: "openai",
          count: 3,
          totals: { ...totals, totalCost: 7, totalTokens: 700 },
        },
      ],
    } as UsageAggregates;

    mountSolid(
      () =>
        UsageInsights({
          totals: costTotals,
          aggregates: costAggregates,
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

    const providerCard = Array.from(container.querySelectorAll(".usage-insight-card")).find(
      (card) => card.querySelector(".usage-insight-title")?.textContent === "Top Providers",
    );
    expect(providerCard?.textContent).toContain("70.0% of cost");
  });

  it("omits cost shares when category totals are not day-scoped", () => {
    const container = document.createElement("div");
    const costTotals = { ...totals, totalCost: 1 };
    const costAggregates = {
      ...aggregates,
      byProvider: [
        {
          provider: "openai",
          count: 3,
          totals: { ...totals, totalCost: 10, totalTokens: 700 },
        },
      ],
    } as UsageAggregates;

    mountSolid(
      () =>
        UsageInsights({
          totals: costTotals,
          aggregates: costAggregates,
          stats: {
            durationCount: 0,
            avgDurationMs: 0,
            errorRate: 0,
          },
          showCostHint: false,
          showCostShares: false,
          errorHours: [],
          sessionCount: 1,
          totalSessions: 1,
        }),
      { container },
    );
    flush();

    expect(container.textContent).not.toContain("1000.0% of cost");
  });
});

describe("usage overview presentation owners", () => {
  it.each(["tokens", "cost"] as const)("preserves ordered %s breakdown categories", (mode) => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        CostBreakdownCompact({
          totals: {
            ...totals,
            totalCost: 1,
            outputCost: 0.2,
            inputCost: 0.1,
            cacheWriteCost: 0.3,
            cacheReadCost: 0.4,
          },
          mode,
        }),
      { container },
    );
    flush();

    const categories = [
      "usage-token-output",
      "usage-token-input",
      "usage-token-cache-write",
      "usage-token-cache-read",
    ];
    expect(
      [...container.querySelectorAll(".cost-breakdown-bar .cost-segment")].map((segment) =>
        categories.find((category) => segment.classList.contains(category)),
      ),
    ).toEqual(categories);
    expect(
      [...container.querySelectorAll(".cost-breakdown-legend .legend-item")].map((entry) =>
        entry.textContent?.replaceAll(/\s+/g, " ").trim(),
      ),
    ).toEqual(
      mode === "tokens"
        ? ["Output 40", "Input 100", "Cache Write 600", "Cache Read 300"]
        : ["Output $0.20", "Input $0.10", "Cache Write $0.30", "Cache Read $0.40"],
    );
  });

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
  it("shows the selected range and shorter calendar periods", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderCostWindowComparison(
          [
            dailyEntry("2026-06-01", 100, 1),
            dailyEntry("2026-06-25", 400, 4),
            dailyEntry("2026-07-01", 500, 5),
          ],
          "2026-06-01",
          "2026-07-01",
          "local",
        ),
      { container },
    );
    flush();

    const cards = Array.from(container.querySelectorAll(".cost-window-card")).map((card) => ({
      label: card.querySelector(".cost-window-card__label")?.textContent?.trim(),
      value: card.querySelector(".cost-window-card__value")?.textContent?.trim(),
    }));
    expect(cards).toEqual([
      { label: "Selected Range", value: "$10.00" },
      { label: "Jul 1", value: "$5.00" },
      { label: "Last 7 days", value: "$9.00" },
      { label: "Last 30 days", value: "$9.00" },
    ]);
  });

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

    const range = container.querySelector(".cost-window-card--range");
    expect(range?.querySelector(".cost-window-card__value")?.textContent?.trim()).toBe("$0.0030");
    expect(range?.querySelector(".cost-window-card__meta")?.textContent).toContain("$0.0001 / day");
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

  it("keeps roster-wide statistics while paging fifty rows", () => {
    const base = createUsageProps();
    const overview = createUsageOverview({
      total: 1250,
      tableSessionCount: 1250,
      tableTotals: { tokens: 125000, cost: 125, errors: 25 },
    });
    const onPageChange = vi.fn();
    const usage = {
      ...base,
      data: { ...base.data, overview },
      callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onPageChange } },
    };
    const container = document.createElement("div");
    mountSolid(
      () =>
        SessionsCard({
          sessions: Array.from({ length: 50 }, (_, index) => session(`Session ${index}`, 1)),
          usage,
          overview,
          totalSessions: 1250,
        }),
      { container },
    );
    flush();
    expect(container.querySelectorAll(".session-bar-row")).toHaveLength(50);
    expect(container.querySelector(".sessions-card-count")?.textContent).toContain("1250 total");
    expect(container.querySelector(".sessions-card-stats")?.textContent).toContain("100 avg");
    expect(container.querySelector(".sessions-card-stats")?.textContent).toContain("25 errors");
    const controls = container.querySelectorAll<HTMLButtonElement>(".data-table-pagination button");
    expect(controls[0]!.disabled).toBe(true);
    controls[1]!.click();
    expect(onPageChange).toHaveBeenCalledWith(50);
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

  it("uses returned day-scoped values and passes the displayed order to selection", () => {
    const base = createUsageProps();
    const onSelectSession = vi.fn();
    const usage = {
      ...base,
      filters: { ...base.filters, selectedDays: ["2026-05-14"] },
      callbacks: { ...base.callbacks, details: { ...base.callbacks.details, onSelectSession } },
    };
    const container = document.createElement("div");
    mountSolid(
      () =>
        SessionsCard({
          sessions: [session("Day winner", 10), session("All time winner", 30)],
          usage,
          totalSessions: 2,
        }),
      { container },
    );
    flush();
    expect(
      [...container.querySelectorAll(".session-bar-value")].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["10", "30"]);
    container
      .querySelector<HTMLButtonElement>(".session-bar-selection")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectSession).toHaveBeenCalledWith("Day winner", true, [
      "Day winner",
      "All time winner",
    ]);
  });

  it("identifies mixed-agent sessions", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        SessionsCard({
          sessions: [
            { ...session("First"), agentId: "main" },
            { ...session("Second"), agentId: "research" },
          ],
          usage: createUsageProps(),
          totalSessions: 2,
        }),
      { container },
    );
    flush();
    await Promise.all(
      [...container.querySelectorAll("openclaw-agent-row-chip")].map((chip) => chip.updateComplete),
    );
    expect(
      [...container.querySelectorAll(".session-bar-row .agent-row-chip")].map((chip) =>
        chip.getAttribute("data-agent-id"),
      ),
    ).toEqual(["main", "research"]);
  });
});
