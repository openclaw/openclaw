import { describe, expect, it } from "vitest";
import { parseQuoteTimestamp } from "./send.js";

describe("parseQuoteTimestamp", () => {
  it("parses a valid numeric timestamp string", () => {
    expect(parseQuoteTimestamp("1771479242643")).toBe(1771479242643);
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(parseQuoteTimestamp(null)).toBeUndefined();
    expect(parseQuoteTimestamp(undefined)).toBeUndefined();
    expect(parseQuoteTimestamp("")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings", () => {
    expect(parseQuoteTimestamp("not-a-number")).toBeUndefined();
    expect(parseQuoteTimestamp("abc123")).toBeUndefined();
  });

  it("returns undefined for zero or negative values", () => {
    expect(parseQuoteTimestamp("0")).toBeUndefined();
    expect(parseQuoteTimestamp("-100")).toBeUndefined();
  });

  it("parses a string with trailing non-numeric chars (parseInt behavior)", () => {
    expect(parseQuoteTimestamp("12345abc")).toBe(12345);
  });
});
