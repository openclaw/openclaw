import { describe, expect, it } from "vitest";
import { isCapitalLivePromotionManualReviewOnly } from "../../scripts/openclaw-capital-live-strategy-readiness.mjs";

describe("capital live strategy readiness", () => {
  it("accepts live_ready only as a manual-review-only promotion state", () => {
    expect(
      isCapitalLivePromotionManualReviewOnly({
        schema: "openclaw.capital.live-trading-promotion-gate.v1",
        status: "live_ready",
        readyForManualReview: true,
        blockerCode: "LIVE_TRADING_MANUAL_REVIEW_REQUIRED",
        liveTradingEnabled: false,
        writeTradingEnabled: false,
        sentOrder: false,
      }),
    ).toBe(true);

    expect(
      isCapitalLivePromotionManualReviewOnly({
        schema: "openclaw.capital.live-trading-promotion-gate.v1",
        status: "live_ready",
        readyForManualReview: true,
        blockerCode: "LIVE_TRADING_MANUAL_REVIEW_REQUIRED",
        liveTradingEnabled: false,
        writeTradingEnabled: true,
        sentOrder: false,
      }),
    ).toBe(false);
  });
});
