import { describe, expect, it } from "vitest";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

describe("replaceSensitiveValuesInRaw", () => {
  it("ignores blank sensitive values while redacting non-empty secrets", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{"token":"","password":"top-secret"}',
      sensitiveValues: ["", "top-secret"],
      redactedSentinel: "__OPENCLAW_REDACTED__",
    });

    expect(result).toBe('{"token":"","password":"__OPENCLAW_REDACTED__"}');
  });
});
