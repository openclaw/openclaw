import { createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import * as usageQuery from "../../../../src/shared/usage-query.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createRecordedCostUsage } from "./test-helpers/recorded-cost.test-support.ts";
import type { UsageProps } from "./types.ts";
import { openUsageDisplay, openUsageFilter, texts } from "./view-render.test-support.ts";
import {
  usageMessages,
  buildAggregatesFromSessions,
  projectUsageData,
  createUsageProps,
  createUsageOverview,
  usageSession,
  usageFixture,
  usageTotals,
} from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

function mountUsage(props: UsageProps, container = document.createElement("div")) {
  mountSolid(() => renderUsage(props), { container });
  flush();
  return container;
}

function mountFixture(
  data: Partial<UsageProps["data"]>,
  filters: Partial<UsageProps["filters"]> = {},
) {
  return mountUsage(usageFixture(data, filters));
}

function mountReactiveUsage(props: UsageProps) {
  const [data, setData] = createSignal(props.data);
  const [display, setDisplay] = createSignal(props.display);
  const [filters, setFilters] = createSignal(props.filters);
  const container = mountUsage({
    ...props,
    get data() {
      return data();
    },
    get display() {
      return display();
    },
    get filters() {
      return filters();
    },
  });
  return { container, data, display, filters, setData, setDisplay, setFilters };
}

function textAt(container: ParentNode, selector: string) {
  return container.querySelector(selector)?.textContent?.trim();
}

function openProviderFilter(container: HTMLElement) {
  const { menu, surface, trigger } = openUsageFilter(container, "Provider");
  return { dropdown: surface, surface, trigger, menu };
}

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
  it("renders the toolbar's filter, display and refresh actions as one row of icon buttons", () => {
    const { container } = mountReactiveUsage(createUsageProps());
    const actions = [...container.querySelectorAll(".usage-view-options button")];
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Filters",
      "Display",
      "Refresh",
    ]);
    for (const button of actions) {
      expect(button.classList.contains("oc-icon-button--32")).toBe(true);
      expect(button.classList.contains("btn")).toBe(false);
    }
  });

  it("identifies each query removal action and removes only its named token", () => {
    const props = createUsageProps();
    props.filters.queryDraft = 'provider:openai "label:Team Planning"';
    const { container, filters, setFilters } = mountReactiveUsage(props);
    props.callbacks.filters.onQueryDraftChange = (queryDraft) =>
      setFilters((current) => ({ ...current, queryDraft }));
    const buttons = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".usage-filter-chip__remove"),
    ];
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove filter: Provider",
      'Remove filter: "label:Team Planning"',
    ]);
    buttons()[1]!.click();
    flush();
    expect(filters().queryDraft.trim()).toBe("provider:openai");
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove filter: Provider",
    ]);
  });

  it("keeps an IME-composed Enter from applying the usage query", () => {
    const props = createUsageProps();
    const onApplyQuery = (props.callbacks.filters.onApplyQuery = vi.fn());
    const container = mountUsage(props);
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    openUsageFilter(container);
    const input = container.querySelector<HTMLInputElement>(".usage-filter-menu__query input")!;
    const enter = (init: KeyboardEventInit = {}) =>
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    const deliberate = enter();
    input.dispatchEvent(deliberate);
    expect(deliberate.defaultPrevented).toBe(true);
    expect(onApplyQuery).toHaveBeenCalledOnce();
    onApplyQuery.mockClear();
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const composed = enter(composition);
      input.dispatchEvent(composed);
      expect(composed.defaultPrevented).toBe(false);
    }
    const end = new CompositionEvent("compositionend", { bubbles: true });
    input.dispatchEvent(end);
    const commit = Object.defineProperty(enter(), "timeStamp", { value: end.timeStamp + 1 });
    input.dispatchEvent(commit);
    expect(commit.defaultPrevented).toBe(false);
    expect(onApplyQuery).not.toHaveBeenCalled();
  });

  it("parses each draft once for chips, suggestions, and every filter", () => {
    const base = createUsageProps();
    base.filters.queryDraft = "provider:OpenAI";
    const overview = createUsageOverview({
      filterOptions: {
        agent: [],
        channel: ["slack"],
        provider: ["OpenAI"],
        model: ["synthetic-model"],
        tool: ["read"],
      },
    });
    const parse = vi.spyOn(usageQuery, "extractQueryTerms");
    try {
      const { container, setFilters, setDisplay } = mountReactiveUsage({
        ...base,
        data: {
          ...base.data,
          overview,
          filterOptions: overview.filterOptions,
        },
      });
      document.body.appendChild(container);
      onTestFinished(() => container.remove());
      openUsageFilter(container);
      expect(textAt(container, ".usage-filter-menu__suggestion")).toBe("provider:OpenAI");
      expect(parse).toHaveBeenCalledExactlyOnceWith("provider:OpenAI");

      setDisplay((current) => ({ ...current, chartMode: "cost" }));
      flush();
      expect(parse).toHaveBeenCalledTimes(1);

      setFilters((current) => ({ ...current, queryDraft: "channel:slack" }));
      flush();
      expect(textAt(container, ".usage-filter-menu__suggestion")).toBe("channel:slack");
      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenLastCalledWith("channel:slack");
    } finally {
      parse.mockRestore();
    }
  });

  it.each(["session", "day"] as const)(
    "restores the range warning after clearing a known-zero %s filter",
    (filter) => {
      const fixture = createRecordedCostUsage();
      const zeroSession = fixture.sessions[0]!;
      const selected: Partial<UsageProps["filters"]> =
        filter === "session"
          ? { selectedSessions: [zeroSession.key] }
          : { selectedDays: zeroSession.usage!.activityDates! };
      const props = usageFixture(
        {
          ...fixture,
          aggregates: buildAggregatesFromSessions(fixture.sessions),
        },
        { startDate: fixture.costDaily[0]!.date },
      );
      const clearedFilters = { ...props.filters };
      const container = document.createElement("div");
      const [currentFilters, setFilters] = createSignal(props.filters);
      mountUsage(
        {
          ...props,
          get filters() {
            return currentFilters();
          },
          get data() {
            return { ...props.data, ...projectUsageData(fixture.sessions, currentFilters()) };
          },
        },
        container,
      );
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
    const container = mountFixture({ providerUsageUnavailable: true });

    expect(container.textContent).toContain("Couldn’t load provider usage. Refresh to try again.");
  });

  it("does not fall back to global insights when a query matches no sessions", () => {
    const sessions = [usageSession("agent:main:main", "main", "openai")];
    const container = mountFixture(projectUsageData(sessions, { query: "missing-session" }), {
      query: "missing-session",
      queryDraft: "missing-session",
    });

    const providers = insightCard(container, "Top providers");
    expect(providers?.textContent).toContain("No provider data yet.");
    expect(providers?.textContent).not.toContain("openai");
  });

  it("keeps selected session labels on UTF-16 boundaries", () => {
    const label = `${"a".repeat(19)}🚀${"b".repeat(28)}🚀tail`;
    const session = {
      key: "agent:main:emoji",
      label,
      agentId: "main",
      updatedAt: Date.now(),
      usage: usageTotals(1, 0),
    } satisfies UsageProps["data"]["sessions"][number];

    const container = mountFixture({ sessions: [session] }, { selectedSessions: [session.key] });

    expect(textAt(container, ".filter-chip-label")).toContain(`${"a".repeat(19)}…`);
    expect(textAt(container, ".session-detail-title")).toBe(
      `${"a".repeat(19)}🚀${"b".repeat(28)}…`,
    );
  });

  it("retains an open query menu while selecting multiple options", async () => {
    const base = createUsageProps();
    const sessions = ["clear", "second"].map((provider) =>
      usageSession(`session:${provider}`, "main", provider),
    );
    base.data = { ...base.data, ...projectUsageData(sessions) };
    const { container, setFilters } = mountReactiveUsage(base);
    const onQueryDraftChange = vi.fn((queryDraft: string) =>
      setFilters((current) => ({ ...current, queryDraft })),
    );
    base.callbacks.filters.onQueryDraftChange = onQueryDraftChange;
    document.body.appendChild(container);
    try {
      expect(container.querySelector(".usage-filter-menu__query input")).toBeNull();
      const { dropdown, surface, trigger } = openProviderFilter(container);
      const first = [...dropdown.querySelectorAll('[role="menuitemcheckbox"]')].find(
        (item) => item.getAttribute("aria-label") === "clear",
      )!;
      expect(trigger.getAttribute("aria-label")).toBe("Provider");
      await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      for (const provider of ["clear", "second"]) {
        const option = [
          ...dropdown.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'),
        ].find((item) => item.getAttribute("aria-label") === provider)!;
        option.click();
        await waitForSolid(() => expect(option.getAttribute("aria-checked")).toBe("true"));
        expect(trigger.textContent).toContain(provider === "clear" ? "clear" : "2");
        expect(first.closest('[role="menu"]')).toBe(surface);
        expect(container.contains(dropdown)).toBe(true);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(surface.matches(":popover-open")).toBe(true);
      }
      expect(onQueryDraftChange.mock.lastCall?.[0]).toBe("provider:clear provider:second ");
      const mainTrigger = container.querySelector<HTMLButtonElement>(
        ".usage-filter-menu__trigger",
      )!;
      mainTrigger.click();
      await waitForSolid(() => expect(mainTrigger.getAttribute("aria-expanded")).toBe("false"));
      expect(first.isConnected).toBe(true);
      openProviderFilter(container);
      await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      expect(dropdown.querySelector('[aria-label="clear"]')).toBe(first);
      expect(first.getAttribute("aria-checked")).toBe("true");
    } finally {
      container.remove();
    }
  });

  it("updates the existing breakdown when mode and totals change", () => {
    const initial = usageTotals(100, 1, {
      output: 20,
      totalTokens: 120,
      inputCost: 0.8,
      outputCost: 0.2,
    });
    const { container, setData, setDisplay } = mountReactiveUsage(
      usageFixture({ totals: initial }),
    );
    const breakdown = container.querySelector(".cost-breakdown")!;
    expect(textAt(breakdown, ".cost-breakdown-total")).toContain("120");
    setDisplay((current) => ({ ...current, chartMode: "cost" }));
    flush();
    expect(container.querySelector(".cost-breakdown")).toBe(breakdown);
    expect(textAt(breakdown, ".cost-breakdown-total")).toContain("Total: $1.00");
    setData((current) => ({ ...current, totals: { ...initial, inputCost: 1.8, totalCost: 2 } }));
    flush();
    expect(textAt(breakdown, ".cost-breakdown-total")).toContain("Total: $2.00");
    expect(textAt(breakdown, ".cost-breakdown-legend")).toContain("$1.80");
  });

  it("refreshes filter order and draft selections when chart mode, agent, or source changes", () => {
    const props = createUsageProps();
    props.data.sessions = [
      usageSession("first", "main", "first", { totalTokens: 200, totalCost: 1 }),
      usageSession("second", "other", "second", { totalTokens: 100, totalCost: 2 }),
    ];
    props.data.overview = projectUsageData(props.data.sessions).overview;
    props.data.filterOptions = props.data.overview?.filterOptions;
    props.filters.query = "provider:absent";
    props.filters.queryDraft = 'label:"Team  Planning" provider:second';
    props.callbacks.filters.onQueryDraftChange = vi.fn();
    const { container, data, display, setData, setDisplay } = mountReactiveUsage(props);
    document.body.appendChild(container);
    onTestFinished(() => container.remove());
    openUsageDisplay(container);
    container.querySelector<HTMLButtonElement>(".usage-display-menu__trigger")!.click();
    flush();
    const { dropdown } = openProviderFilter(container);
    const providerOptions = () =>
      dropdown.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]');
    const values = () => [...providerOptions()].map((option) => option.getAttribute("aria-label"));
    const chartModeButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".usage-display-menu__metric button")].find(
        (button) => button.textContent?.trim() === label,
      );

    expect(chartModeButton("Tokens")?.getAttribute("aria-pressed")).toBe("true");
    expect(chartModeButton("Cost")?.getAttribute("aria-pressed")).toBe("false");
    expect(values()).toEqual(["second", "first"]);
    expect(
      [...providerOptions()]
        .find((option) => option.getAttribute("aria-checked") === "true")
        ?.getAttribute("aria-label"),
    ).toBe("second");
    expect(textAt(container, ".usage-filter-menu__suggestion")).toBe("provider:second");

    setDisplay({ ...display(), chartMode: "cost" });
    flush();
    expect(chartModeButton("Tokens")?.getAttribute("aria-pressed")).toBe("false");
    expect(chartModeButton("Cost")?.getAttribute("aria-pressed")).toBe("true");
    expect(values()).toEqual(["second", "first"]);
    // The replacement report is already scoped by the Gateway.
    setData({
      ...data(),
      ...projectUsageData(data().sessions.filter((session) => session.agentId === "main")),
    });
    flush();
    expect(values()).toEqual(["second", "first"]);
    expect(container.querySelector(".usage-filter-menu__suggestion")).toBeNull();

    setData({
      ...data(),
      ...projectUsageData([usageSession("replacement", "main", "second-new")]),
    });
    flush();
    expect(values()).toEqual(["second", "second-new"]);
    container.querySelector<HTMLButtonElement>(".usage-filter-menu__suggestion")?.click();
    expect(props.callbacks.filters.onQueryDraftChange).toHaveBeenCalledWith(
      'label:"Team  Planning" provider:second-new ',
    );
  });

  it("keeps available provider usage visible when refresh stalls", () => {
    const container = mountFixture({
      providerUsage: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Weekly", usedPercent: 25 }],
        },
      ],
      providerUsageStalled: true,
    });

    expect(container.querySelector(".usage-callout")?.textContent).toContain(
      "Couldn’t finish loading provider usage",
    );
    const card = container.querySelector(".provider-usage-card");
    for (const label of ["OpenAI", "Weekly"]) {
      expect(card?.textContent).toContain(label);
    }
  });

  it("renders provider plans, quotas, and billing independently of session usage", () => {
    const container = mountFixture({
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
    });

    const card = container.querySelector(".provider-usage-card");
    for (const label of ["OpenRouter", "Production", "75% left", "$64.50", "$5.00 / $20.00"]) {
      expect(card?.textContent).toContain(label);
    }
    expect(
      Array.from(
        container.querySelectorAll(".provider-usage__row .oc-menu-panel-usage-value"),
        (value) => value.textContent,
      ),
    ).toEqual(["$64.50", "$5.00 / $20.00", "¥13 / ¥20", "1.5  Credits  / 3  Credits "]);
    expect(card?.querySelector(".provider-usage__window-value")?.textContent).toBe("75% left");
  });

  it("keeps complete insights and history beyond the visible page", () => {
    const totals = usageTotals(1_000, 10, { missingCostEntries: 1 });
    const visibleUsage = usageTotals(10, 0.1);
    const visibleDay = { ...visibleUsage, date: "2026-05-14" };

    const container = mountFixture(
      {
        totals,
        costDaily: [
          { ...usageTotals(990, 9.9, { missingCostEntries: 1 }), date: "2026-05-01" },
          visibleDay,
        ],
        aggregates: {
          ...buildAggregatesFromSessions([]),
          messages: {
            total: 100,
            user: 50,
            assistant: 50,
            toolCalls: 0,
            toolResults: 0,
            errors: 0,
          },
        },
        sessions: [
          {
            key: "agent:main:visible",
            agentId: "main",
            updatedAt: Date.UTC(2026, 4, 14, 12),
            usage: {
              ...visibleUsage,
              dailyBreakdown: [{ ...visibleDay, tokens: 10, cost: 0.1 }],
              messageCounts: usageMessages(),
            },
          },
        ],
      },
      { startDate: "2026-05-01", endDate: "2026-05-14" },
    );

    const messagesValue = [
      ...container.querySelectorAll(".usage-overview-card .usage-summary-card"),
    ]
      .find((card) =>
        card.querySelector(".usage-summary-title")?.textContent?.startsWith("Messages"),
      )
      ?.querySelector(".usage-summary-value");
    expect(messagesValue?.textContent?.trim()).toBe("100");
    expect(container.textContent).toContain(
      "Cost data is missing for some or all sessions in this range.",
    );
    expect(texts(container, ".usage-metric-badge strong", false)).toEqual(["1.0K", "$10.00", "1"]);
    const firstDay = container.querySelector(".daily-bar-wrapper");
    expect(firstDay?.getAttribute("aria-label")).toContain("May 1, 2026");
    expect(firstDay?.getAttribute("aria-label")).toContain("990 tokens, $9.90");
    expect(firstDay?.querySelector(".daily-bar--empty")).toBeNull();
    expect(textAt(container, ".cost-window--range .cost-window__value")).toBe("$10.00");
  });

  it("shows the empty state for an all-zero successful response", () => {
    const container = mountFixture({ totals: createEmptyCostUsageTotals() });
    expect(container.querySelector(".usage-empty-state")).not.toBeNull();
  });

  it("does not render the empty state under an error callout", () => {
    const container = mountFixture({ error: "usage failed" });
    expect(container.querySelector(".usage-callout")).not.toBeNull();
    expect(container.querySelector(".usage-empty-state")).toBeNull();
  });
});
