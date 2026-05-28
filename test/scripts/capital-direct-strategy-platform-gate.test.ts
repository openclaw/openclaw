import { describe, expect, it } from "vitest";
import {
  buildPlatformQuoteFreshnessSummary,
  strategyRuleBlockers,
} from "../../scripts/openclaw-capital-direct-strategy-platform-gate.mjs";

describe("capital direct strategy platform gate", () => {
  it("keeps stale A50 separate from multi-target paper quote readiness", () => {
    const result = buildPlatformQuoteFreshnessSummary({
      directStatus: {
        summary: {
          quote: {
            a50Status: "stale",
          },
        },
      },
      targetRegistry: {
        activeUniverse: [
          {
            id: "brokerdesk-fresh-nq0000",
            quoteSymbol: "NQ0000",
            wallClockFresh: true,
            canGeneratePaperIntent: true,
          },
          {
            id: "a50-direct-request",
            quoteSymbol: "CN0000",
            wallClockFresh: false,
            canGeneratePaperIntent: false,
          },
        ],
        summary: {
          brokerDeskDynamicTargetCount: 1,
        },
      },
      currentPaperIntents: {
        status: "current_paper_intents_written",
        targetRegistry: {
          generatedIntentCount: 1,
        },
      },
    });

    expect(result).toMatchObject({
      overallFreshness: "multi_target_fresh",
      strategyQuoteReady: true,
      directA50Fresh: false,
      multiTargetFresh: true,
      freshPaperTargetCount: 1,
      noLiveOrderSent: true,
    });
    expect(result.freshPaperSymbols).toEqual(["NQ0000"]);
  });

  it("does not promote non-critical failed rules to blockers when evaluator recommends promote", () => {
    expect(
      strategyRuleBlockers({
        recommendation: "promote",
        failedRules: [{ id: "rule_sharpe", label: "Sharpe proxy", value: 0.0998 }],
      }),
    ).toEqual([]);

    expect(
      strategyRuleBlockers({
        recommendation: "reject",
        failedRules: [{ id: "rule_sharpe", label: "Sharpe proxy", value: 0.0998 }],
      }),
    ).toEqual(["strategy_rule:rule_sharpe"]);
  });
});
