import { describe, expect, it } from "vitest";
import { sanitizeLogRecordForSink, sanitizeStringForSink } from "./redact-sink.js";
import { getDefaultRedactPatterns, resolveRedactOptions } from "./redact.js";

const resolved = resolveRedactOptions({
  mode: "tools",
  patterns: getDefaultRedactPatterns(),
});

const disabled = resolveRedactOptions({
  mode: "off",
  patterns: getDefaultRedactPatterns(),
});

const SECRET = "abcdef1234567890ghij";
const MASKED = "abcdef…ghij";
const ULID = "01HWKJFQ7N3Y8B3GMJKK0HXMZ8";

describe("redact-sink", () => {
  it("sanitizes sink strings with shared redaction rules", () => {
    expect(sanitizeStringForSink(`Authorization: Bearer ${SECRET}`, resolved)).toBe(
      `Authorization: Bearer ${MASKED}`,
    );
  });

  it("sanitizes nested log records without mutating the source", () => {
    const record = {
      message: `Authorization: Bearer ${SECRET}`,
      nested: {
        apiKey: SECRET,
      },
      items: [`Authorization: Bearer ${SECRET}`, { token: SECRET }],
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain(MASKED);
    expect(serialized).not.toContain(SECRET);
    expect(record.nested.apiKey).toBe(SECRET);
    expect(record.items[0]).toBe(`Authorization: Bearer ${SECRET}`);
  });

  it("preserves non-credential values while still masking message args and credential fields", () => {
    const record = {
      0: SECRET,
      time: "2026-02-27T15:04:00.000+08:00",
      host: "api.production.openclaw.ai:443",
      requestIds: [ULID],
      token: SECRET,
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved);

    expect(sanitized[0]).toBe(MASKED);
    expect(sanitized.time).toBe(record.time);
    expect(sanitized.host).toBe(record.host);
    expect(sanitized.requestIds).toEqual(record.requestIds);
    expect(sanitized.token).toBe(MASKED);
  });

  it("sanitizes Error payloads and stays JSON-safe for cycles", () => {
    const error = Object.assign(new Error(`Authorization: Bearer ${SECRET}`), {
      apiKey: SECRET,
    });
    const record: Record<string, unknown> = {
      error,
      nested: {},
    };
    record.nested = record;

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain(MASKED);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[Circular]");
  });

  it("short-circuits when redaction mode is off", () => {
    const record = { token: SECRET };

    expect(sanitizeStringForSink(`Authorization: Bearer ${SECRET}`, disabled)).toBe(
      `Authorization: Bearer ${SECRET}`,
    );
    expect(sanitizeLogRecordForSink(record, disabled)).toBe(record);
  });

  it("preserves toJSON semantics for URL, Buffer, and custom classes", () => {
    class Tagged {
      constructor(private readonly id: string) {}
      toJSON() {
        return { kind: "tagged", id: this.id };
      }
    }

    const record = {
      endpoint: new URL("https://api.openclaw.ai/v1/resource?k=v"),
      payload: Buffer.from([1, 2, 3, 4]),
      tagged: new Tagged("abc"),
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      endpoint: unknown;
      payload: { type: string; data: number[] };
      tagged: { kind: string; id: string };
    };

    // URL.toJSON() returns the href string; must not become {}.
    expect(sanitized.endpoint).toBe("https://api.openclaw.ai/v1/resource?k=v");
    // Buffer.toJSON() returns { type: "Buffer", data: [...] }; must be preserved.
    expect(sanitized.payload).toEqual({ type: "Buffer", data: [1, 2, 3, 4] });
    // Custom toJSON must be honored rather than bypassed by Object.entries.
    expect(sanitized.tagged).toEqual({ kind: "tagged", id: "abc" });
  });

  it("forces masking when a credential-named field holds an object with toJSON", () => {
    // The toJSON path must honour the credential-key context so that the
    // serialized string is still forced-masked even when pattern matching misses it.
    const tokenObj = {
      toJSON() {
        return SECRET; // returns an 18+ char string that patterns won't catch
      },
    };

    const record = { token: tokenObj };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as { token: string };

    expect(sanitized.token).toBe(MASKED);
    expect(sanitized.token).not.toContain(SECRET);
  });

  it("forces masking for nested objects under a credential-named parent key", () => {
    // { token: { value: SECRET } } — the inner string must still be masked even
    // though the inner key "value" is not itself a credential name. Without
    // threading options through sanitizeRecordForSink, the nested record walk
    // would drop the credential-key context and leak the raw secret.
    const record = {
      token: { value: SECRET },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      token: { value: string };
    };

    expect(sanitized.token.value).toBe(MASKED);
    // Source must not be mutated.
    expect(record.token.value).toBe(SECRET);
  });

  it("forces masking for array elements under a credential-named parent key", () => {
    // { apiKey: [SECRET, SECRET] } — each array element string must be masked,
    // mirroring the toJSON and nested-object paths.
    const record = {
      apiKey: [SECRET, SECRET],
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      apiKey: string[];
    };

    expect(sanitized.apiKey[0]).toBe(MASKED);
    expect(sanitized.apiKey[1]).toBe(MASKED);
  });

  it("forces masking for credential array entries with characters outside shouldMaskDirectString", () => {
    // Regression for Codex CR: entries like "abcd/efghijklmnopqrstu" contain "/"
    // which falls outside the shouldMaskDirectString charset, so they previously
    // bypassed forced masking when the array was under a credential-named field.
    const slashSecret = "abcd/efghijklmnopqrstu";
    const record = {
      apiKey: [slashSecret],
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      apiKey: string[];
    };

    // Must be masked regardless of charset — credential-key context must propagate.
    expect(sanitized.apiKey[0]).not.toBe(slashSecret);
    expect(sanitized.apiKey[0]).toBe("abcd/e…rstu");
  });

  it("forces masking when a credential-named field holds a toJSON object", () => {
    // { secret: { toJSON: () => SECRET } } — the serialized string must be masked.
    const record = {
      secret: {
        toJSON() {
          return SECRET;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      secret: string;
    };

    expect(sanitized.secret).toBe(MASKED);
  });

  it("forces masking for credential toJSON strings with characters outside shouldMaskDirectString", () => {
    // Regression: toJSON returning a string with '/' was not forced-masked because
    // sanitizeValueForSink called sanitizeStringForSink without the explicit
    // forced-mask fallback that sanitizeFieldValueForSink applies. Now the string
    // branch in sanitizeValueForSink mirrors the array branch: pattern-redact first,
    // unconditionally maskDirectSecret if unchanged.
    const slashSecret = "abcd/efghijklmnopqrstu";
    const record = {
      token: {
        toJSON() {
          return slashSecret;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      token: string;
    };

    expect(sanitized.token).not.toBe(slashSecret);
    expect(sanitized.token).toBe("abcd/e…rstu");
  });

  it("does not mask ISO-8601 timestamps in non-credential fields", () => {
    // Regression: shouldMaskDirectString regex /^[A-Za-z0-9._:+\-=]{18,}$/ matched
    // ISO timestamps, causing them to be silently masked in message/time fields.
    const isoTs = "2026-04-20T12:00:00.000Z";
    const record = {
      message: isoTs,
      time: isoTs,
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved);

    expect(sanitized.message).toBe(isoTs);
    expect(sanitized.time).toBe(isoTs);
  });
});
