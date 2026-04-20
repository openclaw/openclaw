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
});
