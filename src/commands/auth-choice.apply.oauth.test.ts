import { describe, expect, it } from "vitest";
import { _test } from "./auth-choice.apply.oauth.js";

const { validateOAuthRedirectUri } = _test;

/**
 * VULN-023: OAuth redirect URI validation
 *
 * Tests for OAuth redirect URI validation to prevent open redirect attacks (CWE-601).
 */

describe("VULN-023: OAuth redirect URI validation", () => {
  describe("validateOAuthRedirectUri", () => {
    it("returns default URI when input is empty", () => {
      expect(validateOAuthRedirectUri("")).toBe("http://127.0.0.1:1456/oauth-callback");
      expect(validateOAuthRedirectUri("  ")).toBe("http://127.0.0.1:1456/oauth-callback");
    });

    it("allows localhost with correct port", () => {
      expect(validateOAuthRedirectUri("http://localhost:1456/oauth-callback")).toBe(
        "http://localhost:1456/oauth-callback",
      );
    });

    it("allows 127.0.0.1 with correct port", () => {
      expect(validateOAuthRedirectUri("http://127.0.0.1:1456/oauth-callback")).toBe(
        "http://127.0.0.1:1456/oauth-callback",
      );
    });

    it("rejects external hostnames", () => {
      expect(() => validateOAuthRedirectUri("https://attacker.example.com/steal")).toThrow(
        /Invalid OAuth redirect hostname/,
      );
      expect(() => validateOAuthRedirectUri("http://evil.com:1456/callback")).toThrow(
        /Invalid OAuth redirect hostname/,
      );
    });

    it("rejects wrong port", () => {
      expect(() => validateOAuthRedirectUri("http://localhost:9999/callback")).toThrow(
        /Invalid OAuth redirect port/,
      );
      expect(() => validateOAuthRedirectUri("http://127.0.0.1:8080/callback")).toThrow(
        /Invalid OAuth redirect port/,
      );
    });

    it("rejects missing port (defaults to 80)", () => {
      // URL without port defaults to 80 for http, which should be rejected
      expect(() => validateOAuthRedirectUri("http://localhost/oauth-callback")).toThrow(
        /Invalid OAuth redirect port/,
      );
      expect(() => validateOAuthRedirectUri("http://127.0.0.1/callback")).toThrow(
        /Invalid OAuth redirect port/,
      );
    });

    it("rejects https for localhost", () => {
      expect(() => validateOAuthRedirectUri("https://localhost:1456/callback")).toThrow(
        /must use http: protocol/,
      );
    });

    it("rejects invalid URLs", () => {
      expect(() => validateOAuthRedirectUri("not-a-url")).toThrow(/Invalid OAuth redirect URI/);
    });
  });
});
