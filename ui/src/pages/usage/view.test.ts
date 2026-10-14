import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRecordedCostUsage } from "./test-helpers/recorded-cost.test-support.ts";
import type { UsageProps, UsageTotals } from "./types.ts";
import {
  buildAggregatesFromSessions,
  projectUsageData,
  createUsageProps,
  usageSession,
} from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

function insightCard(container: ParentNode, title: string): Element | undefined {
  return Array.from(container.querySelectorAll(".usage-insight-card")).find(
    (card) => card.querySelector(".usage-insight-title")?.textContent === title,
  );
}

function averageCostSummary(container: ParentNode) {
  const hint = container.querySelector("#usage-summary-hint-average-cost");
  return {
    hint: hint?.parentElement?.querySelector('[slot="content"]')?.textContent?.trim(),
    value: hint
      ?.closest(".usage-summary-card")
      ?.querySelector(".usage-summary-value")
      ?.textContent?.trim(),
  };
}

describe("renderUsage", () => {
  it.each(["session", "day"] as const)(
    "restores the range warning after clearing a known-zero %s filter",
    (filter) => {
      const base = createUsageProps();
      const fixture = createRecordedCostUsage();
      const zeroSession = fixture.sessions[0]!;
      const selected: Partial<UsageProps["filters"]> =
        filter === "session"
          ? { selectedSessions: [zeroSession.key] }
          : { selectedDays: zeroSession.usage!.activityDates! };
      const props = createUsageProps({
        data: {
          ...base.data,
          ...fixture,
          aggregates: buildAggregatesFromSessions(fixture.sessions),
        },
        filters: { ...base.filters, startDate: fixture.costDaily[0]!.date },
      });
      const clearedFilters = { ...props.filters };
      const container = document.createElement("div");
      const [currentFilters, setFilters] = createSignal(props.filters);
      mountSolid(
        () =>
          renderUsage({
            ...props,
            get filters() {
              return currentFilters();
            },
            get data() {
              return { ...props.data, ...projectUsageData(fixture.sessions, currentFilters()) };
            },
          }),
        { container },
      );
      flush();
      for (const { filters, missing, value } of [
        { filters: clearedFilters, missing: true, value: "$0.03" },
        { filters: { ...clearedFilters, ...selected }, missing: false, value: "$0.00" },
        { filters: clearedFilters, missing: true, value: "$0.03" },
      ]) {
        setFilters(filters);
        flush();
        expect(averageCostSummary(container)).toEqual({
          hint: missing
            ? "Average cost per message when providers report costs. Cost data is missing for some or all sessions in this range."
            : "Average cost per message when providers report costs.",
          value,
        });
      }
    },
  );

  it("surfaces a provider-usage failure instead of hiding the panel", () => {
    const container = document.createElement("div");
    const base = createUsageProps();
    mountSolid(
      () =>
        renderUsage(createUsageProps({ data: { ...base.data, providerUsageUnavailable: true } })),
      { container },
    );
    flush();

    expect(container.textContent).toContain(
      "Provider usage is unavailable; the last request failed. Refresh to retry.",
    );
  });

  it("does not fall back to global insights when a query matches no sessions", () => {
    const container = document.createElement("div");
    const sessions = [usageSession("agent:main:main", "main", "openai")];

    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...createUsageProps().data,
              ...projectUsageData(sessions, { query: "missing-session" }),
            },
            filters: {
              ...createUsageProps().filters,
              query: "missing-session",
              queryDraft: "missing-session",
            },
          }),
        ),
      { container },
    );
    flush();

    const providers = insightCard(container, "Top Providers");
    expect(providers?.textContent).toContain("No provider data");
    expect(providers?.textContent).not.toContain("openai");
  });

  it("keeps selected session labels on UTF-16 boundaries", () => {
    const container = document.createElement("div");
    const label = `${"a".repeat(19)}🚀${"b".repeat(28)}🚀tail`;
    const session = {
      key: "agent:main:emoji",
      label,
      agentId: "main",
      updatedAt: Date.now(),
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    } satisfies UsageProps["data"]["sessions"][number];

    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: { ...createUsageProps().data, sessions: [session] },
            filters: {
              ...createUsageProps().filters,
              selectedSessions: [session.key],
            },
          }),
        ),
      { container },
    );
    flush();

    expect(container.querySelector(".filter-chip-label")?.textContent).toContain(
      `${"a".repeat(19)}…`,
    );
    expect(container.querySelector(".session-detail-title")?.textContent?.trim()).toBe(
      `${"a".repeat(19)}🚀${"b".repeat(28)}…`,
    );
  });

  it("retains an open query menu while selecting multiple options", async () => {
    const base = createUsageProps();
    const sessions = ["clear", "second"].map((provider) =>
      usageSession(`session:${provider}`, "main", provider),
    );
    const [filters, setFilters] = createSignal(base.filters);
    const onQueryDraftChange = vi.fn((queryDraft: string) =>
      setFilters((current) => ({ ...current, queryDraft })),
    );
    const container = document.body.appendChild(document.createElement("div"));
    try {
      mountSolid(
        () =>
          renderUsage({
            ...base,
            get filters() {
              return filters();
            },
            data: { ...base.data, ...projectUsageData(sessions) },
            callbacks: {
              ...base.callbacks,
              filters: { ...base.callbacks.filters, onQueryDraftChange },
            },
          }),
        { container },
      );
      flush();
      const first = [...container.querySelectorAll(".usage-filter-option")].find(
        (item) => item.getAttribute("aria-label") === "clear",
      )!;
      const dropdown = first.closest(".usage-filter-select")!;
      const surface = dropdown.querySelector<HTMLElement>('[role="menu"]')!;
      const trigger = dropdown.querySelector<HTMLButtonElement>(".usage-filter-trigger")!;
      expect(trigger.getAttribute("aria-label")).toBe("Provider All");
      // JSDOM has no scrolling layout; keep the real Menu click and focus paths.
      for (const item of surface.querySelectorAll<HTMLElement>('[role^="menuitem"]')) {
        item.scrollIntoView = vi.fn();
      }
      trigger.click();
      await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      for (const provider of ["clear", "second"]) {
        const option = [
          ...dropdown.querySelectorAll<HTMLButtonElement>(".usage-filter-option"),
        ].find((item) => item.getAttribute("aria-label") === provider)!;
        option.click();
        await waitForSolid(() => expect(option.getAttribute("aria-checked")).toBe("true"));
        expect(trigger.getAttribute("aria-label")).toBe(`Provider ${provider === "clear" ? 1 : 2}`);
        expect(first.closest(".usage-filter-select")).toBe(dropdown);
        expect(dropdown.querySelector('[role="menu"]')).toBe(surface);
        expect(container.contains(dropdown)).toBe(true);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(surface.matches(":popover-open")).toBe(true);
      }
      expect(onQueryDraftChange.mock.lastCall?.[0]).toBe("provider:clear provider:second ");
    } finally {
      container.remove();
    }
  });

  it("updates the existing breakdown when mode and totals change", () => {
    const base = createUsageProps();
    const initial: UsageTotals = {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      inputCost: 0.8,
      outputCost: 0.2,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 1,
      missingCostEntries: 0,
    };
    const [data, setData] = createSignal({ ...base.data, totals: initial });
    const [display, setDisplay] = createSignal(base.display);
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsage({
          ...base,
          get data() {
            return data();
          },
          get display() {
            return display();
          },
        }),
      { container },
    );
    flush();
    const breakdown = container.querySelector(".cost-breakdown")!;
    expect(breakdown.querySelector(".cost-breakdown-total")?.textContent).toContain("120");
    setDisplay((current) => ({ ...current, chartMode: "cost" }));
    flush();
    expect(container.querySelector(".cost-breakdown")).toBe(breakdown);
    expect(breakdown.querySelector(".cost-breakdown-total")?.textContent).toContain("Total: $1.00");
    setData((current) => ({ ...current, totals: { ...initial, inputCost: 1.8, totalCost: 2 } }));
    flush();
    expect(breakdown.querySelector(".cost-breakdown-total")?.textContent).toContain("Total: $2.00");
    expect(breakdown.querySelector(".cost-breakdown-legend")?.textContent).toContain("$1.80");
  });

  it("refreshes filter order and draft selections when chart mode, agent, or source changes", () => {
    const container = document.createElement("div");
    const props = createUsageProps();
    props.data.sessions = [
      usageSession("first", "main", "first", { totalTokens: 200, totalCost: 1 }),
      usageSession("second", "other", "second", { totalTokens: 100, totalCost: 2 }),
    ];
    props.data.overview = projectUsageData(props.data.sessions).overview;
    props.filters.query = "provider:absent";
    props.filters.queryDraft = 'label:"Team  Planning" provider:second';
    props.callbacks.filters.onQueryDraftChange = vi.fn();
    const providerOptions = () =>
      [...container.querySelectorAll<HTMLElement>(".usage-filter-select")]
        .find((menu) =>
          menu.querySelector(".usage-filter-trigger")?.textContent?.trim().startsWith("Provider"),
        )!
        .querySelectorAll<HTMLElement>(".usage-filter-option");
    const values = () => [...providerOptions()].map((option) => option.getAttribute("aria-label"));
    const chartModeButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".usage-view-options button")].find(
        (button) => button.textContent?.trim() === label,
      );

    const [data, setData] = createSignal(props.data);
    const [display, setDisplay] = createSignal(props.display);
    mountSolid(
      () =>
        renderUsage({
          ...props,
          get data() {
            return data();
          },
          get display() {
            return display();
          },
        }),
      { container },
    );
    flush();
    expect(chartModeButton("Tokens")?.getAttribute("aria-pressed")).toBe("true");
    expect(chartModeButton("Cost")?.getAttribute("aria-pressed")).toBe("false");
    expect(values()).toEqual(["first", "second"]);
    expect(
      [...providerOptions()]
        .find((option) => option.getAttribute("aria-checked") === "true")
        ?.getAttribute("aria-label"),
    ).toBe("second");
    expect(container.querySelector(".usage-query-suggestion")?.textContent?.trim()).toBe(
      "provider:second",
    );

    setDisplay({ ...display(), chartMode: "cost" });
    flush();
    expect(chartModeButton("Tokens")?.getAttribute("aria-pressed")).toBe("false");
    expect(chartModeButton("Cost")?.getAttribute("aria-pressed")).toBe("true");
    expect(values()).toEqual(["first", "second"]);
    // The replacement report is already scoped by the Gateway.
    setData({
      ...data(),
      ...projectUsageData(data().sessions.filter((session) => session.agentId === "main")),
    });
    flush();
    expect(values()).toEqual(["first"]);
    expect(container.querySelector(".usage-query-suggestion")).toBeNull();

    setData({
      ...data(),
      ...projectUsageData([usageSession("replacement", "main", "second-new")]),
    });
    flush();
    expect(values()).toEqual(["second-new"]);
    container.querySelector<HTMLButtonElement>(".usage-query-suggestion")?.click();
    expect(props.callbacks.filters.onQueryDraftChange).toHaveBeenCalledWith(
      'label:"Team  Planning" provider:second-new ',
    );
  });

  it("keeps available provider usage visible when refresh stalls", () => {
    const container = document.createElement("div");

    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...createUsageProps().data,
              providerUsage: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  windows: [{ label: "Weekly", usedPercent: 25 }],
                },
              ],
              providerUsageStalled: true,
            },
          }),
        ),
      { container },
    );
    flush();

    expect(container.querySelector(".usage-callout")?.textContent).toContain(
      "Provider usage did not finish loading",
    );
    const card = container.querySelector(".provider-usage-card");
    expect(card?.textContent).toContain("OpenAI");
    expect(card?.textContent).toContain("Weekly");
  });

  it("renders provider plans, quotas, and billing independently of session usage", () => {
    const container = document.createElement("div");

    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...createUsageProps().data,
              providerUsage: [
                {
                  provider: "openrouter",
                  displayName: "OpenRouter",
                  plan: "Production",
                  windows: [{ label: "API key budget", usedPercent: 25 }],
                  billing: [
                    {
                      type: "balance",
                      label: "Account balance",
                      amount: 64.5,
                      unit: "USD",
                    },
                    {
                      type: "budget",
                      label: "API key budget",
                      used: 5,
                      limit: 20,
                      unit: "USD",
                    },
                    { type: "budget", used: 12.5, limit: 20, unit: " jPy " },
                    { type: "budget", used: 1.5, limit: 3, unit: " Credits " },
                  ],
                },
              ],
            },
          }),
        ),
      { container },
    );
    flush();

    const card = container.querySelector(".provider-usage-card");
    expect(card?.textContent).toContain("OpenRouter");
    expect(card?.textContent).toContain("Production");
    expect(card?.textContent).toContain("75% left");
    expect(card?.textContent).toContain("$64.50");
    expect(card?.textContent).toContain("$5.00 / $20.00");
    expect(
      Array.from(
        container.querySelectorAll(".provider-usage-billing-row strong"),
        (value) => value.textContent,
      ),
    ).toEqual(["$64.50", "$5.00 / $20.00", "¥13 / ¥20", "1.5  Credits  / 3  Credits "]);
  });

  it("keeps complete insights and history beyond the visible page", () => {
    const container = document.createElement("div");
    const base = createUsageProps();
    const totals: UsageTotals = {
      input: 1_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000,
      totalCost: 10,
      inputCost: 10,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 1,
    };
    const visibleDay = {
      ...totals,
      missingCostEntries: 0,
      date: "2026-05-14",
      input: 10,
      totalTokens: 10,
      totalCost: 0.1,
      inputCost: 0.1,
    };

    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...base.data,
              totals,
              costDaily: [
                {
                  ...totals,
                  date: "2026-05-01",
                  input: 990,
                  totalTokens: 990,
                  totalCost: 9.9,
                  inputCost: 9.9,
                },
                visibleDay,
              ],
              aggregates: {
                messages: {
                  total: 100,
                  user: 50,
                  assistant: 50,
                  toolCalls: 0,
                  toolResults: 0,
                  errors: 0,
                },
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
              },
              sessions: [
                {
                  key: "agent:main:visible",
                  agentId: "main",
                  updatedAt: Date.UTC(2026, 4, 14, 12),
                  usage: {
                    input: 10,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 10,
                    totalCost: 0.1,
                    inputCost: 0.1,
                    outputCost: 0,
                    cacheReadCost: 0,
                    cacheWriteCost: 0,
                    missingCostEntries: 0,
                    dailyBreakdown: [{ ...visibleDay, tokens: 10, cost: 0.1 }],
                    messageCounts: {
                      total: 2,
                      user: 1,
                      assistant: 1,
                      toolCalls: 0,
                      toolResults: 0,
                      errors: 0,
                    },
                  },
                },
              ],
            },
            filters: {
              ...base.filters,
              startDate: "2026-05-01",
              endDate: "2026-05-14",
            },
          }),
        ),
      { container },
    );
    flush();

    const messagesValue = container.querySelector(
      ".usage-overview-card .usage-summary-card--hero .usage-summary-value",
    );
    expect(messagesValue?.textContent?.trim()).toBe("100");
    expect(container.textContent).toContain(
      "Cost data is missing for some or all sessions in this range.",
    );
    expect(
      [...container.querySelectorAll(".usage-metric-badge strong")].map((el) => el.textContent),
    ).toEqual(["1.0K", "$10.00", "1"]);
    const firstDay = container.querySelector(".daily-bar-wrapper");
    expect(firstDay?.getAttribute("aria-label")).toContain("May 1, 2026");
    expect(firstDay?.getAttribute("aria-label")).toContain("990 tokens, $9.90");
    expect(firstDay?.querySelector(".daily-bar--empty")).toBeNull();
    expect(
      container
        .querySelector(".cost-window-card--range .cost-window-card__value")
        ?.textContent?.trim(),
    ).toBe("$10.00");
  });

  it("shows the empty state for an all-zero successful response", () => {
    const zeroTotals = {
      totalTokens: 0,
      totalCost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      missingCostEntries: 0,
    };
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...createUsageProps().data,
              // The gateway always returns a totals object, even with no usage.
              totals: zeroTotals as UsageProps["data"]["totals"],
            },
          }),
        ),
      { container },
    );
    flush();
    expect(container.querySelector(".usage-empty-state")).not.toBeNull();
  });

  it("does not render the empty state under an error callout", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsage(
          createUsageProps({
            data: {
              ...createUsageProps().data,
              error: "usage failed",
            },
          }),
        ),
      { container },
    );
    flush();
    expect(container.querySelector(".usage-callout")).not.toBeNull();
    expect(container.querySelector(".usage-empty-state")).toBeNull();
  });
});
