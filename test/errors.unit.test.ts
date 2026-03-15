import { describe, it, expect } from "vitest";
import { FormattedError, isFormattedError } from "../src/errors/formatted-error.js";
import { ErrorFormatter } from "../src/errors/error-formatter.js";
import { createFormattedError, ERROR_MESSAGES } from "../src/errors/error-messages.js";
import { CLI_ERROR_CODES, ErrorSeverity, isCliErrorCode } from "../src/errors/error-codes.js";

describe("ErrorCodes", () => {
  it("should export all error codes", () => {
    expect(CLI_ERROR_CODES.length).toBeGreaterThan(20);
  });

  it("should validate error codes correctly", () => {
    expect(isCliErrorCode("ERR_AUTH_FAILED")).toBe(true);
    expect(isCliErrorCode("ERR_INVALID_CODE")).toBe(false);
    expect(isCliErrorCode(123)).toBe(false);
    expect(isCliErrorCode(null)).toBe(false);
  });
});

describe("FormattedError", () => {
  it("should create a formatted error with all fields", () => {
    const error = new FormattedError({
      code: "ERR_AUTH_FAILED",
      message: "Auth failed",
      description: "Authentication failed",
      suggestions: ["Try logging in", "Check your token"],
      severity: ErrorSeverity.ERROR,
      docsUrl: "https://docs.example.com",
    });

    expect(error.code).toBe("ERR_AUTH_FAILED");
    expect(error.message).toBe("Auth failed");
    expect(error.description).toBe("Authentication failed");
    expect(error.suggestions).toEqual(["Try logging in", "Check your token"]);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.docsUrl).toBe("https://docs.example.com");
  });

  it("should support cause chaining", () => {
    const cause = new Error("Underlying error");
    const error = new FormattedError({
      code: "ERR_INTERNAL_ERROR",
      message: "Internal error",
      cause,
    });

    expect(error.cause).toBe(cause);
  });

  it("should correctly identify itself", () => {
    const error = new FormattedError({
      code: "ERR_AUTH_FAILED",
      message: "Test",
    });

    expect(isFormattedError(error)).toBe(true);
    expect(isFormattedError(new Error("Not formatted"))).toBe(false);
  });

  it("should support JSON serialization", () => {
    const error = new FormattedError({
      code: "ERR_CONFIG_MISSING",
      message: "Config missing",
      suggestions: ["Create config"],
    });

    const json = error.toJSON();
    expect(json.code).toBe("ERR_CONFIG_MISSING");
    expect(json.message).toBe("Config missing");
    expect(json.suggestions).toEqual(["Create config"]);
  });

  it("should identify fatal errors", () => {
    const fatalError = new FormattedError({
      code: "ERR_INTERNAL_ERROR",
      message: "Fatal",
      severity: ErrorSeverity.FATAL,
    });

    const normalError = new FormattedError({
      code: "ERR_WARN",
      message: "Warning",
      severity: ErrorSeverity.WARN,
    });

    expect(fatalError.isFatal()).toBe(true);
    expect(normalError.isFatal()).toBe(false);
  });

  it("should get suggestions correctly", () => {
    const error = new FormattedError({
      code: "ERR_AUTH_FAILED",
      message: "Test",
      suggestions: ["Step 1", "Step 2", "Step 3"],
    });

    expect(error.getPrimarySuggestion()).toBe("Step 1");
    expect(error.getAllSuggestions()).toEqual(["Step 1", "Step 2", "Step 3"]);
  });
});

describe("ErrorMessages Catalog", () => {
  it("should have entries for all error codes", () => {
    for (const code of CLI_ERROR_CODES) {
      expect(ERROR_MESSAGES[code]).toBeDefined();
      expect(ERROR_MESSAGES[code].description).toBeTruthy();
      expect(Array.isArray(ERROR_MESSAGES[code].suggestions)).toBe(true);
      expect(ERROR_MESSAGES[code].suggestions.length).toBeGreaterThan(0);
    }
  });

  it("should have realistic error descriptions", () => {
    const authError = ERROR_MESSAGES.ERR_AUTH_FAILED;
    expect(authError.description).toContain("Authentication");
    expect(authError.suggestions.length).toBeGreaterThanOrEqual(2);
  });

  it("should provide docs URLs for complex errors", () => {
    const configError = ERROR_MESSAGES.ERR_CONFIG_INVALID;
    expect(configError.docsUrl).toBeTruthy();
    expect(configError.docsUrl).toMatch(/^https:\/\//);
  });

  it("should create formatted errors from catalog", () => {
    const error = createFormattedError("ERR_RATE_LIMIT_EXCEEDED", {
      message: "Too many requests",
    });

    expect(error.code).toBe("ERR_RATE_LIMIT_EXCEEDED");
    expect(error.message).toBe("Too many requests");
    expect(error.severity).toBe(ErrorSeverity.WARN);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  it("should use catalog defaults if no override", () => {
    const error = createFormattedError("ERR_NETWORK_ERROR");

    expect(error.description).toContain("Network error");
    expect(error.suggestions.length).toBeGreaterThan(0);
  });
});

describe("ErrorFormatter", () => {
  it("should format errors with colors for display", () => {
    const error = new FormattedError({
      code: "ERR_AUTH_FAILED",
      message: "Auth failed",
      description: "Your token is invalid",
      suggestions: ["Refresh token", "Log in again"],
      severity: ErrorSeverity.ERROR,
      docsUrl: "https://docs.example.com",
    });

    const formatted = ErrorFormatter.formatForDisplay(error);

    expect(formatted).toContain("ERR_AUTH_FAILED");
    expect(formatted).toContain("Your token is invalid");
    expect(formatted).toContain("Refresh token");
    expect(formatted).toContain("https://docs.example.com");
  });

  it("should format as JSON for structured output", () => {
    const error = new FormattedError({
      code: "ERR_CONFIG_MISSING",
      message: "Config is missing",
      suggestions: ["Initialize config"],
    });

    const json = ErrorFormatter.formatAsJson(error);

    expect(json.error.code).toBe("ERR_CONFIG_MISSING");
    expect(json.error.message).toBe("Config is missing");
    expect(Array.isArray(json.error.suggestions)).toBe(true);
  });

  it("should format for logs", () => {
    const error = new FormattedError({
      code: "ERR_GATEWAY_TIMEOUT",
      message: "Gateway timeout",
      suggestions: ["Retry command"],
      severity: ErrorSeverity.WARN,
    });

    const logFormat = ErrorFormatter.formatForLogs(error);

    expect(logFormat).toContain("WARN");
    expect(logFormat).toContain("ERR_GATEWAY_TIMEOUT");
    expect(logFormat).toContain("Gateway timeout");
  });

  it("should normalize unknown errors to FormattedError", () => {
    const unknownError = new Error("Something went wrong");
    const normalized = ErrorFormatter.normalizeError(unknownError);

    expect(isFormattedError(normalized)).toBe(true);
    expect(normalized.code).toBe("ERR_INTERNAL_ERROR");
    expect(normalized.description).toContain("Something went wrong");
  });

  it("should extract error code from message if available", () => {
    const error = new Error("ERR_AUTH_FAILED: Token is invalid");
    const normalized = ErrorFormatter.normalizeError(error);

    expect(normalized.code).toBe("ERR_AUTH_FAILED" as any);
    expect(normalized.description).toBe("Token is invalid");
  });

  it("should get correct severity emoji", () => {
    expect(ErrorFormatter.severityEmoji(ErrorSeverity.INFO)).toBe("ℹ️");
    expect(ErrorFormatter.severityEmoji(ErrorSeverity.WARN)).toBe("⚠️");
    expect(ErrorFormatter.severityEmoji(ErrorSeverity.ERROR)).toBe("❌");
    expect(ErrorFormatter.severityEmoji(ErrorSeverity.FATAL)).toBe("🔴");
  });

  it("should format multiple errors", () => {
    const errors = [
      new FormattedError({
        code: "ERR_AUTH_FAILED",
        message: "Auth failed",
      }),
      new FormattedError({
        code: "ERR_CONFIG_MISSING",
        message: "Config missing",
      }),
    ];

    const formatted = ErrorFormatter.formatMultipleForDisplay(errors);

    expect(formatted).toContain("ERR_AUTH_FAILED");
    expect(formatted).toContain("ERR_CONFIG_MISSING");
  });
});

describe("Error Severity", () => {
  it("should have correct severity levels", () => {
    expect(ErrorSeverity.INFO).toBe("INFO");
    expect(ErrorSeverity.WARN).toBe("WARN");
    expect(ErrorSeverity.ERROR).toBe("ERROR");
    expect(ErrorSeverity.FATAL).toBe("FATAL");
  });
});
