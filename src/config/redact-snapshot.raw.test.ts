import { describe, expect, it } from "vitest";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

describe("replaceSensitiveValuesInRaw", () => {
  it("ignores empty sensitive values so raw redaction does not explode", () => {
    const raw = JSON.stringify({
      channels: {
        qzone: { cookie: "" },
        youtube: { oauthClientSecret: "" },
        discourse: { apiKey: "top-secret-value" }, // pragma: allowlist secret
      },
    });

    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["", "", "top-secret-value"],
      redactedSentinel: "__OPENCLAW_REDACTED__",
    });

    expect(result).toContain('"cookie":""');
    expect(result).toContain('"oauthClientSecret":""');
    expect(result).not.toContain("top-secret-value");
    expect(result).toContain("__OPENCLAW_REDACTED__");
    expect(result.length).toBeLessThan(raw.length * 3);
  });

  it("deduplicates repeated non-empty secrets before replaceAll", () => {
    const raw = '{"a":"same-secret","b":"same-secret"}';
    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["same-secret", "same-secret"],
      redactedSentinel: "__OPENCLAW_REDACTED__",
    });

    expect(result).toBe('{"a":"__OPENCLAW_REDACTED__","b":"__OPENCLAW_REDACTED__"}');
  });
});
