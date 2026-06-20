// FIX #89662: Test that context indicator shows even with stale data
import { describe, it, expect, beforeEach } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  getContextNoticeViewModel,
  resetContextNoticeThemeCacheForTest,
} from "./context-notice.ts";

describe("getContextNoticeViewModel", () => {
  // Reset theme cache between tests to ensure consistent colors
  beforeEach(() => {
    resetContextNoticeThemeCacheForTest();
  });

  it("should return null when session is undefined", () => {
    expect(getContextNoticeViewModel(undefined, null)).toBeNull();
  });

  it("should return null when totalTokens is undefined", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: undefined,
      totalTokensFresh: true,
      contextTokens: 100000,
    };
    expect(getContextNoticeViewModel(session as GatewaySessionRow, null)).toBeNull();
  });

  it("should return null when totalTokens is invalid (negative)", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: -100,
      totalTokensFresh: true,
      contextTokens: 100000,
    };
    expect(getContextNoticeViewModel(session as GatewaySessionRow, null)).toBeNull();
  });

  it("should return null when totalTokens is NaN", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: NaN,
      totalTokensFresh: true,
      contextTokens: 100000,
    };
    expect(getContextNoticeViewModel(session as GatewaySessionRow, null)).toBeNull();
  });

  it("should return null when contextTokens is missing and no default", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 5000,
      totalTokensFresh: true,
      contextTokens: undefined,
    };
    expect(getContextNoticeViewModel(session as GatewaySessionRow, null)).toBeNull();
  });

  it("should render indicator with fresh low-usage data", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 18000,
      totalTokensFresh: true,
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(10); // 18k / 180k = 10%
    expect(result!.warning).toBe(false);
    expect(result!.compactRecommended).toBe(false);
  });

  it("should render indicator with fresh high-usage data (warning)", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 160000,
      totalTokensFresh: true,
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(89); // 160k / 180k ≈ 89%
    expect(result!.warning).toBe(true); // >= 85%
    expect(result!.compactRecommended).toBe(false); // 89% < 90%, so false
  });

  it("should recommend compaction with fresh very-high-usage data", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 170000,
      totalTokensFresh: true,
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(94); // 170k / 180k ≈ 94%
    expect(result!.warning).toBe(true); // >= 85%
    expect(result!.compactRecommended).toBe(true); // >= 90%
  });

  // FIX #89662: KEY TEST - should show indicator even with stale data
  it("should render indicator with stale but valid low-usage data (FIX #89662)", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 18000,
      totalTokensFresh: false, // Stale data
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);

    // BEFORE FIX: This would return null (indicator hidden)
    // AFTER FIX: Should return valid view model
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(10);
    expect(result!.warning).toBe(false);
    expect(result!.compactRecommended).toBe(false); // Don't recommend compaction with stale data
  });

  it("should render indicator with stale high-usage data (warning still applies)", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 160000,
      totalTokensFresh: false, // Stale data
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);

    expect(result).not.toBeNull();
    expect(result!.pct).toBe(89);
    expect(result!.warning).toBe(true); // Warning threshold still applies
    // Note: compactRecommended depends on implementation - may be false for stale data
  });

  it("should use defaultContextTokens when session.contextTokens is undefined", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 5000,
      totalTokensFresh: true,
      contextTokens: undefined,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, 100000);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(5); // 5k / 100k = 5%
  });

  it("should handle edge case of zero tokens used", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 0,
      totalTokensFresh: true,
      contextTokens: 100000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(0);
    expect(result!.warning).toBe(false);
  });

  it("should cap percentage at 100% even if usage exceeds limit", () => {
    const session: Partial<GatewaySessionRow> = {
      totalTokens: 200000,
      totalTokensFresh: true,
      contextTokens: 180000,
    };
    const result = getContextNoticeViewModel(session as GatewaySessionRow, null);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(100); // Capped at 100%
    expect(result!.warning).toBe(true);
  });
});
