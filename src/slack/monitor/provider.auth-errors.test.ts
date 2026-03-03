import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

const { isPermanentSlackAuthError, extractSlackErrorCode } = __testing;

describe("slack permanent auth error detection", () => {
  describe("isPermanentSlackAuthError", () => {
    it("detects account_inactive error", () => {
      const error = new Error("An API error occurred: account_inactive");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects invalid_auth error", () => {
      const error = new Error("An API error occurred: invalid_auth");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects token_revoked error", () => {
      const error = new Error("An API error occurred: token_revoked");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects not_authed error", () => {
      const error = new Error("An API error occurred: not_authed");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects account_suspended error", () => {
      const error = new Error("An API error occurred: account_suspended");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects error regardless of case", () => {
      const error = new Error("AN API ERROR OCCURRED: ACCOUNT_INACTIVE");
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("detects error in mixed message context", () => {
      const error = new Error(
        "Failed to connect: An API error occurred: account_inactive, please check your token",
      );
      expect(isPermanentSlackAuthError(error)).toBe(true);
    });

    it("returns false for transient errors", () => {
      const error = new Error("An API error occurred: rate_limited");
      expect(isPermanentSlackAuthError(error)).toBe(false);
    });

    it("returns false for network errors", () => {
      const error = new Error("ECONNREFUSED");
      expect(isPermanentSlackAuthError(error)).toBe(false);
    });

    it("returns false for timeout errors", () => {
      const error = new Error("ETIMEDOUT");
      expect(isPermanentSlackAuthError(error)).toBe(false);
    });

    it("returns false for non-Error objects", () => {
      expect(isPermanentSlackAuthError("string error")).toBe(false);
      expect(isPermanentSlackAuthError({ message: "error" })).toBe(false);
      expect(isPermanentSlackAuthError(null)).toBe(false);
      expect(isPermanentSlackAuthError(undefined)).toBe(false);
    });
  });

  describe("extractSlackErrorCode", () => {
    it("extracts error code from standard Slack error message", () => {
      const error = new Error("An API error occurred: account_inactive");
      expect(extractSlackErrorCode(error)).toBe("account_inactive");
    });

    it("extracts error code regardless of case", () => {
      const error = new Error("AN API ERROR OCCURRED: INVALID_AUTH");
      expect(extractSlackErrorCode(error)).toBe("invalid_auth");
    });

    it("returns null for non-matching message format", () => {
      const error = new Error("Something went wrong");
      expect(extractSlackErrorCode(error)).toBeNull();
    });

    it("returns null for non-Error objects", () => {
      expect(extractSlackErrorCode("string error")).toBeNull();
      expect(extractSlackErrorCode({ message: "error" })).toBeNull();
      expect(extractSlackErrorCode(null)).toBeNull();
      expect(extractSlackErrorCode(undefined)).toBeNull();
    });

    it("extracts error code with underscores", () => {
      const error = new Error("An API error occurred: some_complex_error_code");
      expect(extractSlackErrorCode(error)).toBe("some_complex_error_code");
    });
  });
});
