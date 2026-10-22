/* @vitest-environment jsdom */

import { beforeEach, expect, it } from "vitest";
import {
  appendSessionUsageRollupContribution,
  buildSessionCostSummaryFromRollup,
  createSessionUsageRollupData,
} from "../../../../src/infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { i18n } from "../../i18n/index.ts";
import { buildModelProviderCards } from "./data.ts";
import { mount, props, text } from "./view.test-support.tsx";

beforeEach(() => i18n.setLocale("en"));

it.each([
  ["same model", [["anthropic", "anthropic"]], ["same", "same"], 1, 2],
  ["different models", [["anthropic", "anthropic"]], ["first", "second"], 1, 2],
  ["provider aliases", [["anthropic", "claude-cli"]], ["first", "second"], 1, 2],
  ["multiple sessions", [["anthropic", "anthropic"], ["anthropic"]], ["first", "second"], 2, 3],
] as const)(
  "labels real local-cost contributions as messages across %s",
  (_name, sessions, models, sessionCount, messageCount) => {
    const accumulator = createUsageAggregateAccumulator();
    const start = Date.UTC(2026, 0, 1);
    const noTools = { toolNames: [], toolResultCounts: { total: 0, errors: 0 } };
    for (const [sessionIndex, providers] of sessions.entries()) {
      const rollup = createSessionUsageRollupData();
      appendSessionUsageRollupContribution(rollup, {
        timestamp: start,
        role: "user",
        ...noTools,
      });
      for (const [index, provider] of providers.entries()) {
        appendSessionUsageRollupContribution(rollup, {
          timestamp: start + index + 1,
          role: "assistant",
          provider,
          model: models[index],
          ...noTools,
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
    const messages = aggregates.byProvider.reduce((total, entry) => total + entry.count, 0);
    expect(messages).toBe(messageCount);
    const cards = buildModelProviderCards({
      authStatus: null,
      models: null,
      providerUsage: null,
      costByProvider: aggregates.byProvider,
    });
    const totalTokens = messageCount * 100;
    expect(cards).toMatchObject([{ localCost: { totalTokens, totalCost: messageCount } }]);
    const container = mount(props({ cards }));
    const row = container.querySelector('[data-provider-id="anthropic"]');
    expect(text(row?.querySelector(".model-providers__local-cost-detail") ?? null)).toBe(
      `${totalTokens} tokens · ${messageCount} messages`,
    );
  },
);
