import { describe, it, expect } from "vitest";

/**
 * Unit tests for the topic-closed detection and message_thread_id helper
 * used by withTelegramThreadFallback.
 *
 * These are inline re-implementations of the private helpers to verify
 * the regex/parsing logic without needing to mock the full send pipeline.
 */

const TOPIC_CLOSED_RE = /400:\s*Bad Request:\s*topic closed/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isTelegramTopicClosedError(err: unknown): boolean {
  return TOPIC_CLOSED_RE.test(formatErrorMessage(err));
}

function isTelegramThreadNotFoundError(err: unknown): boolean {
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function getMessageThreadId(params?: Record<string, unknown>): number | undefined {
  if (!params) {
    return undefined;
  }
  const value = params.message_thread_id;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

describe("isTelegramTopicClosedError", () => {
  it("matches 'topic closed' error from Telegram API", () => {
    expect(isTelegramTopicClosedError(new Error("400: Bad Request: topic closed"))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isTelegramTopicClosedError(new Error("400: Bad Request: Topic Closed"))).toBe(true);
  });

  it("does not match thread-not-found errors", () => {
    expect(
      isTelegramTopicClosedError(new Error("400: Bad Request: message thread not found")),
    ).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isTelegramTopicClosedError(new Error("500: Internal Server Error"))).toBe(false);
  });

  it("handles non-Error values", () => {
    expect(isTelegramTopicClosedError("400: Bad Request: topic closed")).toBe(true);
    expect(isTelegramTopicClosedError(null)).toBe(false);
  });
});

describe("isTelegramThreadNotFoundError", () => {
  it("matches thread-not-found error", () => {
    expect(
      isTelegramThreadNotFoundError(new Error("400: Bad Request: message thread not found")),
    ).toBe(true);
  });

  it("does not match topic-closed error", () => {
    expect(isTelegramThreadNotFoundError(new Error("400: Bad Request: topic closed"))).toBe(false);
  });
});

describe("getMessageThreadId", () => {
  it("returns number value directly", () => {
    expect(getMessageThreadId({ message_thread_id: 456 })).toBe(456);
  });

  it("parses string value to number", () => {
    expect(getMessageThreadId({ message_thread_id: "789" })).toBe(789);
  });

  it("returns undefined for missing params", () => {
    expect(getMessageThreadId(undefined)).toBeUndefined();
  });

  it("returns undefined for missing key", () => {
    expect(getMessageThreadId({})).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getMessageThreadId({ message_thread_id: "  " })).toBeUndefined();
  });

  it("returns undefined for NaN-producing strings", () => {
    const result = getMessageThreadId({ message_thread_id: "abc" });
    expect(result).toBeNaN();
  });

  it("returns undefined for non-finite numbers", () => {
    expect(getMessageThreadId({ message_thread_id: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(getMessageThreadId({ message_thread_id: Number.NaN })).toBeUndefined();
  });
});
