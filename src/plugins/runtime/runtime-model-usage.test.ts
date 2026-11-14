import { afterEach, expect, it } from "vitest";
import type { PreparedDecisionBillingFacts } from "../../decisions/host-billing.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { finalizePluginModelUsage } from "./runtime-model-usage.js";

afterEach(resetDiagnosticEventsForTest);

const target = { provider: "fixture", model: "native", agentId: "agent", sessionKey: "session" };
const preparedBilling: PreparedDecisionBillingFacts = {
  provider: "fixture",
  model: "native",
  billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 2, output: 0 } },
};
const requestBilling: PreparedDecisionBillingFacts = {
  ...preparedBilling,
  billing: { unit: "requests", source: "provider-docs" },
};
const finalize = (rawUsage: unknown, facts: PreparedDecisionBillingFacts | undefined) =>
  finalizePluginModelUsage({ cfg: {}, estimate: "none", target, preparedBilling: facts, rawUsage });

it.each(["direct", "aggregate"] as const)(
  "estimates %s cost when no billed total is recorded",
  (estimate) => {
    const usage = finalizePluginModelUsage({
      cfg: {
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "native",
                  name: "Native",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 8192,
                  maxTokens: 1024,
                  cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      estimate,
      target,
      rawUsage: { input: 100 },
    });
    expect(usage).toEqual({ inputTokens: 100, costUsd: 0.0002 });
  },
);

it.each([
  ["known route", preparedBilling, {}, 0.0002],
  ["provider billed zero", preparedBilling, { costUsd: 0 }, 0],
  ["rewritten provider", { ...preparedBilling, provider: "other" }, {}, undefined],
  ["rewritten model", { ...preparedBilling, model: "other" }, {}, undefined],
  ["unknown route", undefined, {}, undefined],
  ["native units", preparedBilling, { units: { unit: "decision-units", amount: 5 } }, undefined],
  ["request billing", requestBilling, {}, undefined],
] as const)(
  "records accepted usage without inventing token prices: %s",
  (_name, facts, usage, cost) => {
    const result = finalize({ inputTokens: 100, ...usage }, facts);
    expect(result.inputTokens).toBe(100);
    expect(result.costUsd).toBe(cost);
  },
);

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
    expect(finalize({ costUsd: 0 }, preparedBilling)).toEqual({ costUsd: 0 });
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
