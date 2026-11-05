import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  createMsFormatter,
  formatCost,
  formatDateTimeRangeMs,
  formatNumber,
  formatUsd,
} from "./format.ts";

afterEach(() => vi.restoreAllMocks());

describe("active UI locale formatting", () => {
  it("keeps currency precision and number caches separate across locale switches", () => {
    const locale = vi.spyOn(i18n, "getLocale");
    for (const language of ["fr", "de", "en", "fr"] as const) {
      locale.mockReturnValue(language);
      for (const [cost, digits] of [
        [0, 2],
        [0.0012, 4],
        [0.125, 3],
        [1234.56, 2],
      ] as const) {
        expect(formatCost(cost)).toBe(
          new Intl.NumberFormat(language, {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(cost),
        );
      }
      for (const digits of [2, 4, 6, 8]) {
        expect(formatUsd(0.00000125, digits)).toBe(
          new Intl.NumberFormat(language, {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(0.00000125),
        );
      }
      expect(formatCost(undefined)).toBe(formatCost(0));
      expect(formatNumber(12345)).toBe(new Intl.NumberFormat(language).format(12345));
    }
  });

  it("updates retained date formatters and delegates compact ranges to Intl", () => {
    const locale = vi.spyOn(i18n, "getLocale");
    const options = { month: "short", day: "numeric", timeZone: "UTC" } as const;
    const format = createMsFormatter(options);
    const first = Date.UTC(2026, 0, 1, 12);
    for (const language of ["fr", "de", "en", "fr"] as const) {
      locale.mockReturnValue(language);
      expect(format(first)).toBe(new Intl.DateTimeFormat(language, options).format(first));
      for (const last of [first + 3600000, first + 86400000, Date.UTC(2027, 0, 1, 12)]) {
        expect(formatDateTimeRangeMs(first, last)).toBe(
          new Intl.DateTimeFormat(language, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).formatRange(first, last),
        );
      }
    }
  });
});
