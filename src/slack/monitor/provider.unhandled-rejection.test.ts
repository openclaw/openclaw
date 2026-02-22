import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerUnhandledRejectionHandler,
  isUnhandledRejectionHandled,
} from "../../infra/unhandled-rejections.js";
import { isSlackPlatformError, isSlackUnrecoverableAuthError } from "./slack-error-detection.js";

/**
 * These tests verify the Slack-specific unhandled rejection handler integration.
 * Detection function unit tests are in slack-error-detection.test.ts;
 * these tests verify the handler registration works correctly with the
 * global unhandled rejection system.
 */

/** Creates a mock Slack Web API platform error (as thrown by @slack/web-api). */
function createSlackPlatformError(apiError: string) {
  return Object.assign(new Error(`An API error occurred: ${apiError}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: apiError },
  });
}

describe("Slack unhandled rejection handler integration", () => {
  let unregister: () => void;

  beforeEach(() => {
    // Register the same handler that monitorSlackProvider() uses
    unregister = registerUnhandledRejectionHandler((reason) => {
      if (isSlackPlatformError(reason) && isSlackUnrecoverableAuthError(reason)) {
        return true; // handled — only suppress unrecoverable auth errors
      }
      return false;
    });
  });

  afterEach(() => {
    unregister();
  });

  it("catches Slack account_inactive as handled", () => {
    const err = createSlackPlatformError("account_inactive");
    expect(isUnhandledRejectionHandled(err)).toBe(true);
  });

  it("catches Slack invalid_auth as handled", () => {
    const err = createSlackPlatformError("invalid_auth");
    expect(isUnhandledRejectionHandled(err)).toBe(true);
  });

  it("catches Slack not_authed as handled", () => {
    const err = createSlackPlatformError("not_authed");
    expect(isUnhandledRejectionHandled(err)).toBe(true);
  });

  it("catches Slack team_disabled as handled", () => {
    const err = createSlackPlatformError("team_disabled");
    expect(isUnhandledRejectionHandled(err)).toBe(true);
  });

  it("catches Slack user_removed_from_team as handled", () => {
    const err = createSlackPlatformError("user_removed_from_team");
    expect(isUnhandledRejectionHandled(err)).toBe(true);
  });

  it("does NOT catch non-auth Slack platform errors (e.g. channel_not_found)", () => {
    const err = createSlackPlatformError("channel_not_found");
    expect(isUnhandledRejectionHandled(err)).toBe(false);
  });

  it("does not catch non-Slack errors", () => {
    expect(isUnhandledRejectionHandled(new Error("unrelated"))).toBe(false);
  });

  it("does not catch network errors (left for other handlers)", () => {
    const err = Object.assign(new Error("connect failed"), { code: "ECONNRESET" });
    expect(isUnhandledRejectionHandled(err)).toBe(false);
  });

  it("does not catch rate-limited errors from Slack (different code)", () => {
    const err = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      data: { ok: false, error: "ratelimited" },
    });
    expect(isUnhandledRejectionHandled(err)).toBe(false);
  });

  it("stops catching after unregister", () => {
    unregister();
    const err = createSlackPlatformError("account_inactive");
    expect(isUnhandledRejectionHandled(err)).toBe(false);
    // Re-register for afterEach cleanup
    unregister = registerUnhandledRejectionHandler(() => false);
  });

  describe("distinguishes auth errors from other platform errors", () => {
    it("identifies unrecoverable auth errors", () => {
      expect(isSlackUnrecoverableAuthError(createSlackPlatformError("account_inactive"))).toBe(
        true,
      );
      expect(isSlackUnrecoverableAuthError(createSlackPlatformError("invalid_auth"))).toBe(true);
    });

    it("identifies non-auth platform errors", () => {
      expect(isSlackUnrecoverableAuthError(createSlackPlatformError("channel_not_found"))).toBe(
        false,
      );
      expect(isSlackUnrecoverableAuthError(createSlackPlatformError("missing_scope"))).toBe(false);
    });
  });
});
