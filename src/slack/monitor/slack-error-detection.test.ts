import { describe, expect, it } from "vitest";
import {
  isSlackPlatformError,
  isSlackUnrecoverableAuthError,
  getSlackErrorCode,
} from "./slack-error-detection.js";

/**
 * Creates a mock Slack Web API PlatformError matching the structure from @slack/web-api.
 * See: @slack/web-api/src/errors.ts → platformErrorFromResult()
 */
function createSlackPlatformError(apiError: string): Error & { code: string; data: { error: string } } {
  const error = Object.assign(new Error(`An API error occurred: ${apiError}`), {
    code: "slack_webapi_platform_error" as const,
    data: { error: apiError },
  });
  return error;
}

describe("isSlackPlatformError", () => {
  it("returns true for Slack platform errors", () => {
    expect(isSlackPlatformError(createSlackPlatformError("account_inactive"))).toBe(true);
    expect(isSlackPlatformError(createSlackPlatformError("invalid_auth"))).toBe(true);
    expect(isSlackPlatformError(createSlackPlatformError("some_other_error"))).toBe(true);
  });

  it("returns false for non-Slack errors", () => {
    expect(isSlackPlatformError(new Error("something"))).toBe(false);
    expect(isSlackPlatformError(Object.assign(new Error("test"), { code: "ECONNRESET" }))).toBe(false);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isSlackPlatformError(null)).toBe(false);
    expect(isSlackPlatformError(undefined)).toBe(false);
    expect(isSlackPlatformError("string")).toBe(false);
    expect(isSlackPlatformError(42)).toBe(false);
  });
});

describe("isSlackUnrecoverableAuthError", () => {
  it("returns true for all unrecoverable auth errors", () => {
    const unrecoverableErrors = [
      "not_authed",
      "invalid_auth",
      "account_inactive",
      "user_removed_from_team",
      "team_disabled",
    ];
    for (const apiError of unrecoverableErrors) {
      expect(
        isSlackUnrecoverableAuthError(createSlackPlatformError(apiError)),
        `expected true for ${apiError}`,
      ).toBe(true);
    }
  });

  it("returns false for other Slack platform errors", () => {
    expect(isSlackUnrecoverableAuthError(createSlackPlatformError("channel_not_found"))).toBe(false);
    expect(isSlackUnrecoverableAuthError(createSlackPlatformError("rate_limited"))).toBe(false);
    expect(isSlackUnrecoverableAuthError(createSlackPlatformError("missing_scope"))).toBe(false);
  });

  it("returns false for non-Slack errors", () => {
    expect(isSlackUnrecoverableAuthError(new Error("invalid_auth"))).toBe(false);
    expect(isSlackUnrecoverableAuthError(null)).toBe(false);
  });
});

describe("getSlackErrorCode", () => {
  it("extracts the API error string from platform errors", () => {
    expect(getSlackErrorCode(createSlackPlatformError("account_inactive"))).toBe("account_inactive");
    expect(getSlackErrorCode(createSlackPlatformError("invalid_auth"))).toBe("invalid_auth");
  });

  it("returns undefined for non-Slack errors", () => {
    expect(getSlackErrorCode(new Error("test"))).toBeUndefined();
    expect(getSlackErrorCode(null)).toBeUndefined();
  });
});
