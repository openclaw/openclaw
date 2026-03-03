import { describe, expect, it } from "vitest";
import { __testing } from "./server-channels.js";

const { isPermanentAuthError } = __testing;

describe("server-channels permanent auth error detection", () => {
  describe("isPermanentAuthError", () => {
    it("detects account_inactive error", () => {
      const error = new Error("An API error occurred: account_inactive");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects invalid_auth error", () => {
      const error = new Error("An API error occurred: invalid_auth");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects token_revoked error", () => {
      const error = new Error("An API error occurred: token_revoked");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects permanent auth failure message", () => {
      const error = new Error("Slack socket mode permanent auth failure (invalid_auth)");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects descriptive bot removed message", () => {
      const error = new Error(
        "Slack authentication failed (account_inactive): The bot was likely removed from the workspace",
      );
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects descriptive token revoked message", () => {
      const error = new Error("Authentication failed: token was revoked by the user");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects account_suspended error", () => {
      const error = new Error("An API error occurred: account_suspended");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects not_authed error", () => {
      const error = new Error("An API error occurred: not_authed");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("detects generic authentication failed message", () => {
      const error = new Error("Authentication failed for the API");
      expect(isPermanentAuthError(error)).toBe(true);
    });

    it("does not detect transient network errors", () => {
      const error = new Error("ECONNREFUSED");
      expect(isPermanentAuthError(error)).toBe(false);
    });

    it("does not detect timeout errors", () => {
      const error = new Error("ETIMEDOUT");
      expect(isPermanentAuthError(error)).toBe(false);
    });

    it("does not detect rate limited errors", () => {
      const error = new Error("An API error occurred: rate_limited");
      expect(isPermanentAuthError(error)).toBe(false);
    });

    it("does not detect generic network errors", () => {
      const error = new Error("Network error: connection reset");
      expect(isPermanentAuthError(error)).toBe(false);
    });

    it("returns false for non-Error objects", () => {
      expect(isPermanentAuthError("string error")).toBe(false);
      expect(isPermanentAuthError({ message: "error" })).toBe(false);
      expect(isPermanentAuthError(null)).toBe(false);
      expect(isPermanentAuthError(undefined)).toBe(false);
    });

    it("is case insensitive", () => {
      const error = new Error("AN API ERROR OCCURRED: ACCOUNT_INACTIVE");
      expect(isPermanentAuthError(error)).toBe(true);
    });
  });
});
