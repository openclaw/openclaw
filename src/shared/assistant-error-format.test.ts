import { describe, expect, it } from "vitest";
import {
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
} from "./assistant-error-format.js";

describe("extractLeadingHttpStatus", () => {
  it("accepts status codes in the valid HTTP range 100-599", () => {
    expect(extractLeadingHttpStatus("100 everything is fine")).toEqual({
      code: 100,
      rest: "everything is fine",
    });
    expect(extractLeadingHttpStatus("500 internal error")).toEqual({
      code: 500,
      rest: "internal error",
    });
    expect(extractLeadingHttpStatus("599 something rest")).toEqual({
      code: 599,
      rest: "something rest",
    });
  });

  it("rejects 3-digit sequences outside the HTTP status code range", () => {
    // 000 / 099 / 999 / 600 — the regex would capture these as 3-digit
    // numbers, but they are not valid HTTP statuses and should not be
    // surfaced as "HTTP <code>" in user-visible messages or in retry
    // classification.
    expect(extractLeadingHttpStatus("000 something")).toBeNull();
    expect(extractLeadingHttpStatus("099 something")).toBeNull();
    expect(extractLeadingHttpStatus("600 something")).toBeNull();
    expect(extractLeadingHttpStatus("999 something")).toBeNull();
  });

  it("rejects strings that do not start with a 3-digit HTTP status", () => {
    expect(extractLeadingHttpStatus("no status here")).toBeNull();
    expect(extractLeadingHttpStatus("")).toBeNull();
  });
});

describe("extractProviderWrappedHttpStatus", () => {
  it("accepts provider-wrapped statuses inside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("OpenAI API error (503): service down")).toEqual({
      code: 503,
      rest: "service down",
    });
    expect(extractProviderWrappedHttpStatus("API error (429): rate limited")).toEqual({
      code: 429,
      rest: "rate limited",
    });
  });

  it("rejects provider-wrapped statuses outside the valid HTTP range", () => {
    expect(extractProviderWrappedHttpStatus("API error (000): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (999): something")).toBeNull();
    expect(extractProviderWrappedHttpStatus("API error (600): something")).toBeNull();
  });
});
