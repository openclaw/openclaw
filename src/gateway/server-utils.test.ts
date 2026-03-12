import { describe, expect, it } from "vitest";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";

describe("normalizeVoiceWakeTriggers", () => {
  it("should return default triggers when input is undefined", () => {
    const result = normalizeVoiceWakeTriggers(undefined);
    expect(result).toEqual(["hey claw", "okay claw"]);
  });

  it("should return default triggers when input is empty array", () => {
    const result = normalizeVoiceWakeTriggers([]);
    expect(result).toEqual(["hey claw", "okay claw"]);
  });

  it("should filter out empty strings and non-string values", () => {
    const input = ["hello", "", "world", null, undefined, 123, {}, []];
    const result = normalizeVoiceWakeTriggers(input);
    expect(result).toEqual(["hello", "world"]);
  });

  it("should trim whitespace from triggers", () => {
    const input = ["  hello  ", "world  ", "  test"];
    const result = normalizeVoiceWakeTriggers(input);
    expect(result).toEqual(["hello", "world", "test"]);
  });

  it("should limit triggers to maximum of 32", () => {
    const input = Array.from({ length: 50 }, (_, i) => `trigger${i}`);
    const result = normalizeVoiceWakeTriggers(input);
    expect(result).toHaveLength(32);
  });

  it("should truncate triggers to maximum of 64 characters", () => {
    const longTrigger = "a".repeat(100);
    const input = [longTrigger];
    const result = normalizeVoiceWakeTriggers(input);
    expect(result[0]).toHaveLength(64);
  });

  it("should return default triggers when all inputs are invalid", () => {
    const input = ["", "   ", null, undefined];
    const result = normalizeVoiceWakeTriggers(input);
    expect(result).toEqual(["hey claw", "okay claw"]);
  });
});

describe("formatError", () => {
  it("should format Error instance", () => {
    const error = new Error("Test error message");
    const result = formatError(error);
    expect(result).toBe("Test error message");
  });

  it("should format Error instance with empty message", () => {
    const error = new Error();
    const result = formatError(error);
    expect(result).toBe("");
  });

  it("should format string error", () => {
    const result = formatError("String error message");
    expect(result).toBe("String error message");
  });

  it("should format empty string", () => {
    const result = formatError("");
    expect(result).toBe("");
  });

  it("should format object with status and code", () => {
    const error = { status: 404, code: "NOT_FOUND" };
    const result = formatError(error);
    expect(result).toBe("status=404 code=NOT_FOUND");
  });

  it("should format object with only status", () => {
    const error = { status: 500 };
    const result = formatError(error);
    expect(result).toBe("status=500 code=unknown");
  });

  it("should format object with only code", () => {
    const error = { code: "TIMEOUT" };
    const result = formatError(error);
    expect(result).toBe("status=unknown code=TIMEOUT");
  });

  it("should format object with numeric status", () => {
    const error = { status: 200, code: 0 };
    const result = formatError(error);
    expect(result).toBe("status=200 code=0");
  });

  it("should format plain object as JSON", () => {
    const error = { message: "Something went wrong", detail: "test" };
    const result = formatError(error);
    expect(result).toBe(JSON.stringify(error, null, 2));
  });

  it("should format null", () => {
    const result = formatError(null);
    expect(result).toBe("null");
  });

  it("should format undefined", () => {
    const result = formatError(undefined);
    expect(result).toBe("undefined");
  });

  it("should format number", () => {
    const result = formatError(404);
    expect(result).toBe("404");
  });

  it("should format boolean", () => {
    const result = formatError(false);
    expect(result).toBe("false");
  });

  it("should format circular object gracefully", () => {
    const error: Record<string, unknown> = { message: "test" };
    error.self = error;
    const result = formatError(error);
    expect(result).toBe("[object Object]");
  });

  it("should format object with toString method", () => {
    const error = {
      toString() {
        return "Custom error";
      },
    };
    const result = formatError(error);
    expect(result).toBe("Custom error");
  });
});
