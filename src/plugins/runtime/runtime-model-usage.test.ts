import { afterEach, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import {
  finalizePluginModelUsage,
  type PreparedDecisionBillingFacts,
} from "./runtime-model-usage.js";

afterEach(resetDiagnosticEventsForTest);

const target = { provider: "fixture", model: "native", agentId: "agent", sessionKey: "session" };
const preparedBilling: PreparedDecisionBillingFacts = {
  provider: "fixture",
  model: "native",
  billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 2, output: 0 } },
};

it.each([
  { name: "known route", facts: preparedBilling, usage: { inputTokens: 100 }, cost: 0.0002 },
  {
    name: "provider billed zero",
    facts: preparedBilling,
    usage: { inputTokens: 100, costUsd: 0 },
    cost: 0,
  },
  {
    name: "rewritten provider",
    facts: { ...preparedBilling, provider: "other" },
    usage: { inputTokens: 100 },
    cost: undefined,
  },
  {
    name: "rewritten model",
    facts: { ...preparedBilling, model: "other" },
    usage: { inputTokens: 100 },
    cost: undefined,
  },
  { name: "unknown route", facts: undefined, usage: { inputTokens: 100 }, cost: undefined },
  {
    name: "native units",
    facts: preparedBilling,
    usage: { inputTokens: 100, units: { unit: "decision-units", amount: 5 } },
    cost: undefined,
  },
  {
    name: "request billing",
    facts: {
      ...preparedBilling,
      billing: { unit: "requests", source: "provider-docs" },
    } satisfies PreparedDecisionBillingFacts,
    usage: { inputTokens: 100 },
    cost: undefined,
  },
])("records accepted usage without inventing token prices: $name", ({ facts, usage, cost }) => {
  const result = finalizePluginModelUsage({
    cfg: {},
    estimate: "none",
    target,
    preparedBilling: facts,
    rawUsage: usage,
  });
  expect(result.inputTokens).toBe(100);
  expect(result.costUsd).toBe(cost);
});

it("emits one sparse trusted observation for explicit zero without fabricating token counts", () => {
  const events: DiagnosticEventPayload[] = [];
  const stop = onTrustedInternalDiagnosticEvent(
    markTrustedOtelDiagnosticListener((event) => {
      if (event.type === "model.usage") {
        events.push(event);
      }
    }),
  );
  try {
    expect(
      finalizePluginModelUsage({
        cfg: {},
        estimate: "none",
        target,
        rawUsage: { costUsd: 0 },
        preparedBilling,
      }),
    ).toEqual({ costUsd: 0 });
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.usage",
        provider: "fixture",
        model: "native",
        sessionKey: "session",
        usage: {},
        costUsd: 0,
      }),
    ]);
  } finally {
    stop();
  }
});
