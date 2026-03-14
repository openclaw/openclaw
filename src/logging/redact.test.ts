import { describe, expect, it, vi } from "vitest";
import { PrivacyDetector } from "../privacy/detector.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveText,
  redactToolDetail,
  redactWithPrivacyFilter,
} from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks Telegram-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("masks Telegram Bot API URL tokens", () => {
    const input =
      "GET https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET https://api.telegram.org/bot123456…cdef/getMe HTTP/1.1");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("ignores unsafe nested-repetition custom patterns", () => {
    const input = `${"a".repeat(28)}!`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["(a+)+$"],
    });
    expect(output).toBe(input);
  });

  it("redacts large payloads with bounded regex passes", () => {
    const input = `${"x".repeat(40_000)} OPENAI_API_KEY=sk-1234567890abcdef ${"y".repeat(40_000)}`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });
});

describe("redactToolDetail", () => {
  it("applies privacy detector redaction for values outside default token patterns", () => {
    const input = "email admin@company.com and backup@example.org";
    const output = redactToolDetail(input);
    expect(output).toContain("***");
    expect(output).not.toContain("admin@company.com");
    expect(output).not.toContain("backup@example.org");
  });

  it("handles overlapping detector matches without truncating trailing content", () => {
    const detectSpy = vi.spyOn(PrivacyDetector.prototype, "detect").mockReturnValue({
      hasPrivacyRisk: true,
      matches: [
        {
          type: "outer",
          content: "SECRET12",
          start: 7,
          end: 15,
          riskLevel: "high",
          description: "outer match",
        },
        {
          type: "inner",
          content: "CRET",
          start: 9,
          end: 13,
          riskLevel: "medium",
          description: "inner match",
        },
      ],
      riskCount: { outer: 1, inner: 1 },
      highestRiskLevel: "high",
    });

    try {
      const output = redactWithPrivacyFilter(
        "prefix SECRET12 tail=SAFE_MARKER",
        { mode: "tools", patterns: [] },
        true,
      );
      expect(output).toContain("tail=SAFE_MARKER");
    } finally {
      detectSpy.mockRestore();
    }
  });

  it("prefers longer equal-start detector matches to avoid partial leaks", () => {
    const detectSpy = vi.spyOn(PrivacyDetector.prototype, "detect").mockReturnValue({
      hasPrivacyRisk: true,
      matches: [
        {
          type: "short",
          content: "SECRET12",
          start: 7,
          end: 15,
          riskLevel: "medium",
          description: "short match",
        },
        {
          type: "long",
          content: "SECRET123456",
          start: 7,
          end: 19,
          riskLevel: "high",
          description: "long match",
        },
      ],
      riskCount: { short: 1, long: 1 },
      highestRiskLevel: "high",
    });

    try {
      const output = redactWithPrivacyFilter(
        "prefix SECRET123456 tail=SAFE_MARKER",
        { mode: "tools", patterns: [] },
        true,
      );
      expect(output).toContain("tail=SAFE_MARKER");
      expect(output).not.toContain("3456");
    } finally {
      detectSpy.mockRestore();
    }
  });
});
