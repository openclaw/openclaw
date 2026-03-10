import { describe, expect, it } from "vitest";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

describe("replaceSensitiveValuesInRaw", () => {
  it("redacts sensitive values from raw string", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"apiKey": "secret123", "name": "test"}',
      sensitiveValues: ["secret123"],
      redactedSentinel: "__REDACTED__",
    });
    expect(result).toBe('{"apiKey": "__REDACTED__", "name": "test"}');
  });

  it("handles multiple sensitive values (longest first)", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"key1": "abc", "key2": "abcdef"}',
      sensitiveValues: ["abc", "abcdef"],
      redactedSentinel: "***",
    });
    expect(result).toBe('{"key1": "***", "key2": "***"}');
  });

  // Regression test for #41247
  it("handles empty strings without throwing RangeError", () => {
    expect(() =>
      replaceSensitiveValuesInRaw({
        raw: '{"key": "value"}',
        sensitiveValues: ["", "value"],
        redactedSentinel: "__REDACTED__",
      }),
    ).not.toThrow();

    const result = replaceSensitiveValuesInRaw({
      raw: '{"key": "value"}',
      sensitiveValues: ["", "value"],
      redactedSentinel: "__REDACTED__",
    });
    expect(result).toBe('{"key": "__REDACTED__"}');
  });

  it("handles null and undefined values", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"key": "secret"}',
      sensitiveValues: [null, undefined, "secret"] as unknown as string[],
      redactedSentinel: "***",
    });
    expect(result).toBe('{"key": "***"}');
  });

  it("returns raw unchanged when no valid sensitive values", () => {
    const raw = '{"key": "value"}';
    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["", null, undefined] as unknown as string[],
      redactedSentinel: "__REDACTED__",
    });
    expect(result).toBe(raw);
  });

  it("uses default sentinel when provided sentinel is empty", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"key": "secret"}',
      sensitiveValues: ["secret"],
      redactedSentinel: "",
    });
    expect(result).toBe('{"key": "__REDACTED__"}');
  });

  it("handles non-string raw input gracefully", () => {
    const nullResult = replaceSensitiveValuesInRaw({
      raw: null as unknown as string,
      sensitiveValues: ["test"],
      redactedSentinel: "***",
    });
    const objectResult = replaceSensitiveValuesInRaw({
      raw: { secret: "test" } as unknown as string,
      sensitiveValues: ["test"],
      redactedSentinel: "***",
    });

    expect(nullResult).toBe("");
    expect(objectResult).toBe("");
  });

  it("handles unicode strings", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"key": "🔑secret🔑"}',
      sensitiveValues: ["🔑secret🔑"],
      redactedSentinel: "***",
    });
    expect(result).toBe('{"key": "***"}');
  });
});
