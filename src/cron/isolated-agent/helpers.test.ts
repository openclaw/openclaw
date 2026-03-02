import { describe, expect, it } from "vitest";
import {
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromPayloads,
} from "./helpers.js";

describe("pickSummaryFromPayloads", () => {
  it("picks real text over error payload", () => {
    const payloads = [
      { text: "Here is your summary" },
      { text: "Tool error: rate limited", isError: true },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("Here is your summary");
  });

  it("falls back to error payload when no real text exists", () => {
    const payloads = [{ text: "Tool error: rate limited", isError: true }];
    expect(pickSummaryFromPayloads(payloads)).toBe("Tool error: rate limited");
  });

  it("returns undefined for empty payloads", () => {
    expect(pickSummaryFromPayloads([])).toBeUndefined();
  });

  it("treats isError: undefined as non-error", () => {
    const payloads = [
      { text: "normal text", isError: undefined },
      { text: "error text", isError: true },
    ];
    expect(pickSummaryFromPayloads(payloads)).toBe("normal text");
  });
});

describe("pickLastNonEmptyTextFromPayloads", () => {
  it("picks real text over error payload", () => {
    const payloads = [{ text: "Real output" }, { text: "Service error", isError: true }];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("Real output");
  });

  it("falls back to error payload when no real text exists", () => {
    const payloads = [{ text: "Service error", isError: true }];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("Service error");
  });

  it("returns undefined for empty payloads", () => {
    expect(pickLastNonEmptyTextFromPayloads([])).toBeUndefined();
  });

  it("treats isError: undefined as non-error", () => {
    const payloads = [
      { text: "good", isError: undefined },
      { text: "bad", isError: true },
    ];
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe("good");
  });
});

describe("pickLastDeliverablePayload", () => {
  it("picks real payload over error payload", () => {
    const real = { text: "Delivered content" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([real, error])).toBe(real);
  });

  it("falls back to error payload when no real payload exists", () => {
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([error])).toBe(error);
  });

  it("returns undefined for empty payloads", () => {
    expect(pickLastDeliverablePayload([])).toBeUndefined();
  });

  it("picks media payload over error text payload", () => {
    const media = { mediaUrl: "https://example.com/img.png" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([media, error])).toBe(media);
  });

  it("treats isError: undefined as non-error", () => {
    const normal = { text: "ok", isError: undefined };
    const error = { text: "bad", isError: true as const };
    expect(pickLastDeliverablePayload([normal, error])).toBe(normal);
  });
});
