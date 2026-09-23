/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  appendSessionUsageRollupContribution,
  buildSessionCostSummaryFromRollup,
  createSessionUsageRollupData,
} from "../../../../src/infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { i18n } from "../../i18n/index.ts";
import { buildModelProviderCards } from "./data.ts";
import { mount, props, text } from "./view.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  for (const container of document.body.querySelectorAll("div")) {
    render(nothing, container);
  }
  document.body.replaceChildren();
});

it.each([
  {
    name: "same model",
    sessions: [["anthropic", "anthropic"]],
    models: ["same", "same"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "different models",
    sessions: [["anthropic", "anthropic"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "provider aliases",
    sessions: [["anthropic", "claude-cli"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "multiple sessions",
    sessions: [["anthropic", "anthropic"], ["anthropic"]],
    models: ["first", "second"],
    sessionCount: 2,
    messageCount: 3,
  },
])(
  "labels real local-cost contributions as messages across $name",
  ({ sessions, models, sessionCount, messageCount }) => {
    const accumulator = createUsageAggregateAccumulator();
    const start = Date.UTC(2026, 0, 1);
    for (const [sessionIndex, providers] of sessions.entries()) {
      const rollup = createSessionUsageRollupData();
      appendSessionUsageRollupContribution(rollup, {
        timestamp: start,
        role: "user",
        toolNames: [],
        toolResultCounts: { total: 0, errors: 0 },
      });
      for (const [index, provider] of providers.entries()) {
        appendSessionUsageRollupContribution(rollup, {
          timestamp: start + index + 1,
          role: "assistant",
          provider,
          model: models[index],
          toolNames: [],
          toolResultCounts: { total: 0, errors: 0 },
          usageTotals: {
            ...createEmptyCostUsageTotals(),
            input: 100,
            totalTokens: 100,
            totalCost: 1,
            inputCost: 1,
          },
        });
      }
      accumulator.add({
        usage: buildSessionCostSummaryFromRollup({
          rollup,
          sessionId: `qa-session-${sessionIndex}`,
          sessionFile: `qa-session-${sessionIndex}`,
          startMs: start,
          endMs: start + 10,
          includeUntimestamped: false,
          formatDay: (date) => date.toISOString().slice(0, 10),
        }),
      });
    }
    const aggregates = accumulator.finish();
    expect(aggregates.sessionCount).toBe(sessionCount);
    expect(aggregates.byProvider.reduce((total, entry) => total + entry.count, 0)).toBe(
      messageCount,
    );
    const cards = buildModelProviderCards({
      authStatus: null,
      models: null,
      providerUsage: null,
      costByProvider: aggregates.byProvider,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.localCost).toMatchObject({
      totalTokens: messageCount * 100,
      totalCost: messageCount,
    });
    const container = mount(props({ cards }));
    const row = container.querySelector('[data-provider-id="anthropic"]');
    expect(text(row?.querySelector(".model-providers__local-cost-detail") ?? null)).toBe(
      `${messageCount * 100} tokens · ${messageCount} messages`,
    );
  },
);
