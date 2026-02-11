import { describe, it, expect } from "vitest";
import type { OutputFilterPattern } from "./types.js";
import { DEPLOYMENT_PATTERNS } from "./patterns.js";

function testPattern(pattern: OutputFilterPattern, input: string): boolean {
  const re = new RegExp(pattern.regex, pattern.flags ?? "g");
  return re.test(input);
}

function findPattern(name: string): OutputFilterPattern {
  const p = DEPLOYMENT_PATTERNS.find((p) => p.name === name);
  if (!p) {
    throw new Error(`Pattern not found: ${name}`);
  }
  return p;
}

describe("DEPLOYMENT_PATTERNS", () => {
  describe("Telegram Bot Token", () => {
    it("matches valid bot token", () => {
      // Real Telegram bot token format: <bot_id>:<35+ base64 chars>
      expect(
        testPattern(
          findPattern("Telegram Bot Token"),
          "123456789:AABBccDDee1234FGhIjKlMnOpQrStUvWxYz01234",
        ),
      ).toBe(true);
    });

    it("does not match short id", () => {
      expect(testPattern(findPattern("Telegram Bot Token"), "123:ABCdef")).toBe(false);
    });
  });

  describe("Generic API Key Assignment", () => {
    it("matches api_key=value", () => {
      expect(
        testPattern(findPattern("Generic API Key Assignment"), "api_key=abcdefghij1234567890"),
      ).toBe(true);
    });

    it("matches API_KEY: value with quotes", () => {
      expect(
        testPattern(
          findPattern("Generic API Key Assignment"),
          'API_KEY: "some_very_long_api_key_value_here"',
        ),
      ).toBe(true);
    });

    it("does not match random hex without prefix", () => {
      expect(
        testPattern(findPattern("Generic API Key Assignment"), "abcdef1234567890abcdef1234567890"),
      ).toBe(false);
    });
  });

  describe("Generic Secret Assignment", () => {
    it("matches secret=value", () => {
      expect(
        testPattern(findPattern("Generic Secret Assignment"), "secret=my_super_secret_value123"),
      ).toBe(true);
    });

    it("matches TOKEN: value", () => {
      expect(
        testPattern(findPattern("Generic Secret Assignment"), "TOKEN: my_token_value_12345678"),
      ).toBe(true);
    });
  });

  describe("Anthropic API Key", () => {
    it("matches sk-ant- prefix", () => {
      expect(testPattern(findPattern("Anthropic API Key"), "sk-ant-abcdefghij1234567890klm")).toBe(
        true,
      );
    });

    it("does not match short key", () => {
      expect(testPattern(findPattern("Anthropic API Key"), "sk-ant-short")).toBe(false);
    });
  });

  describe("Slack Token", () => {
    it("matches xoxb token", () => {
      expect(testPattern(findPattern("Slack Token"), "xoxb-1234567890-abcdefghij")).toBe(true);
    });

    it("matches xoxp token", () => {
      expect(testPattern(findPattern("Slack Token"), "xoxp-1234567890-abcdefghij")).toBe(true);
    });
  });

  describe("Google API Key", () => {
    it("matches AIza prefix", () => {
      expect(
        testPattern(findPattern("Google API Key"), "AIzaSyA1234567890abcdefghijklmnopqrstuv"),
      ).toBe(true);
    });
  });

  describe("Private Key Block", () => {
    it("matches RSA private key header", () => {
      expect(testPattern(findPattern("Private Key Block"), "-----BEGIN RSA PRIVATE KEY-----")).toBe(
        true,
      );
    });

    it("matches generic private key header", () => {
      expect(testPattern(findPattern("Private Key Block"), "-----BEGIN PRIVATE KEY-----")).toBe(
        true,
      );
    });
  });

  describe("false positive avoidance", () => {
    it("API key pattern does not match git SHA-1 without prefix", () => {
      expect(
        testPattern(
          findPattern("Generic API Key Assignment"),
          "commit abc1234567890abcdef1234567890abcdef12345",
        ),
      ).toBe(false);
    });

    it("API key pattern does not match MD5 hash without prefix", () => {
      expect(
        testPattern(
          findPattern("Generic API Key Assignment"),
          "md5: d41d8cd98f00b204e9800998ecf8427e",
        ),
      ).toBe(false);
    });

    it("secret pattern requires keyword prefix", () => {
      expect(
        testPattern(
          findPattern("Generic Secret Assignment"),
          "random_long_string_without_prefix_1234567890",
        ),
      ).toBe(false);
    });
  });

  describe("all patterns compile", () => {
    it("every pattern has valid regex", () => {
      for (const pattern of DEPLOYMENT_PATTERNS) {
        expect(() => new RegExp(pattern.regex, pattern.flags ?? "g")).not.toThrow();
      }
    });
  });
});
