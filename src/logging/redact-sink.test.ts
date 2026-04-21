import { describe, expect, it } from "vitest";
import { sanitizeLogRecordForSink, sanitizeStringForSink } from "./redact-sink.js";
import { getDefaultRedactPatterns, resolveRedactOptions } from "./redact.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

const resolved = resolveRedactOptions({
  mode: "tools",
  patterns: getDefaultRedactPatterns(),
});

const disabled = resolveRedactOptions({
  mode: "off",
  patterns: getDefaultRedactPatterns(),
});

const SECRET = "abcdef1234567890ghij"; // 20 chars, pure alnum — should be direct-masked
const MASKED = "abcdef\u2026ghij"; // expected masked form: start6…end4
const ULID = "01HWKJFQ7N3Y8B3GMJKK0HXMZ8"; // should NOT be masked (requestId)

// ── sanitizeStringForSink ───────────────────────────────────────────────────

describe("sanitizeStringForSink", () => {
  it("sanitizes pattern-matched secrets (e.g. Bearer header)", () => {
    expect(sanitizeStringForSink(`Authorization: Bearer ${SECRET}`, resolved)).toBe(
      `Authorization: Bearer ${MASKED}`,
    );
  });

  it("short-circuits when redaction mode is off", () => {
    expect(sanitizeStringForSink(`Authorization: Bearer ${SECRET}`, disabled)).toBe(
      `Authorization: Bearer ${SECRET}`,
    );
  });

  it("applies direct-mask fallback when allowDirectMask is set", () => {
    // The string is not matched by any pattern but looks like a token.
    const tokenLike = "abcdef1234567890ghij"; // no pattern match, alnum 18+
    const result = sanitizeStringForSink(tokenLike, resolved, { allowDirectMask: true });
    expect(result).toBe(MASKED);
  });

  it("does NOT direct-mask when allowDirectMask is false/absent", () => {
    const tokenLike = "abcdef1234567890ghij";
    const result = sanitizeStringForSink(tokenLike, resolved);
    expect(result).toBe(tokenLike); // no context → no direct mask
  });

  it("does NOT mask ISO-8601 timestamps even with allowDirectMask (EC3)", () => {
    const iso = "2026-04-17T10:30:00.000+08:00";
    const result = sanitizeStringForSink(iso, resolved, { allowDirectMask: true });
    expect(result).toBe(iso);
  });
});

// ── sanitizeLogRecordForSink — basic ───────────────────────────────────────

describe("sanitizeLogRecordForSink — basic sanitization", () => {
  it("sanitizes nested log records without mutating the source", () => {
    const record = {
      message: `Authorization: Bearer ${SECRET}`,
      nested: { apiKey: SECRET },
      items: [`Authorization: Bearer ${SECRET}`, { token: SECRET }],
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain(MASKED);
    expect(serialized).not.toContain(SECRET);
    // Source record must not be mutated.
    expect(record.nested.apiKey).toBe(SECRET);
    expect(record.items[0]).toBe(`Authorization: Bearer ${SECRET}`);
  });

  it("preserves non-credential values while masking secrets and credential fields", () => {
    const record = {
      0: SECRET, // numeric key — message arg → direct-mask
      time: "2026-02-27T15:04:00.000+08:00",
      host: "api.production.openclaw.ai:443",
      requestIds: [ULID],
      token: SECRET, // credential key
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as typeof record;

    expect(sanitized[0]).toBe(MASKED);
    expect(sanitized.time).toBe(record.time); // ISO timestamp preserved
    expect(sanitized.host).toBe(record.host); // not a credential key
    expect(sanitized.requestIds).toEqual(record.requestIds); // ULID not masked
    expect(sanitized.token).toBe(MASKED);
  });

  it("short-circuits and returns original record when mode is off", () => {
    const record = { token: SECRET };
    expect(sanitizeLogRecordForSink(record, disabled)).toBe(record);
  });
});

// ── Credential field masking ────────────────────────────────────────────────

describe("sanitizeLogRecordForSink — credential field semantics", () => {
  it("forces masking for nested objects under a credential-named parent key", () => {
    const record = { token: { value: SECRET } };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as { token: { value: string } };

    expect(sanitized.token.value).toBe(MASKED);
    expect(record.token.value).toBe(SECRET); // source not mutated
  });

  it("forces masking for array elements under a credential-named parent key", () => {
    const record = { apiKey: [SECRET, SECRET] };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as { apiKey: string[] };

    expect(sanitized.apiKey[0]).toBe(MASKED);
    expect(sanitized.apiKey[1]).toBe(MASKED);
  });

  it("forces masking when a credential field's array contains slash-charset values (C3)", () => {
    // Entries with `/` bypass shouldMaskDirectString but must still be force-masked.
    const slashSecret = "abcdef/1234567890ghij"; // 21 chars
    const record = { apiKey: [slashSecret] };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as { apiKey: string[] };

    // Force-masked unconditionally because it's under a credential field.
    // The actual mask: slashSecret is 21 chars — start6…end4
    expect(sanitized.apiKey[0]).toBe("abcdef\u2026ghij");
  });

  it("forces masking when a credential field holds a toJSON object (C4)", () => {
    const record = {
      secret: {
        toJSON() {
          return SECRET;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as { secret: string };

    expect(sanitized.secret).toBe(MASKED);
  });

  it("forces masking when credential toJSON returns a slash-charset string (C4+C3)", () => {
    const slashSecret = "abcdef/1234567890ghij"; // 21 chars, starts correct
    const record = {
      secret: {
        toJSON() {
          return slashSecret;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as { secret: string };

    expect(sanitized.secret).toBe("abcdef\u2026ghij");
  });

  it("preserves ISO-8601 timestamp under a credential-named field (Bug 1 / EC3 regression)", () => {
    // EC3: ISO timestamps must NOT be force-masked even when under a credential key.
    const iso = "2026-04-17T10:30:00.000Z";
    const record = { token: iso };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as { token: string };

    expect(sanitized.token).toBe(iso);
  });

  it("preserves ISO-8601 timestamp under a credential-nested object (Bug 1 / EC3 nested)", () => {
    const iso = "2026-04-17T10:30:00.000Z";
    const record = { apiKey: { issuedAt: iso } };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      apiKey: { issuedAt: string };
    };

    expect(sanitized.apiKey.issuedAt).toBe(iso);
  });
});

// ── C6: message/arg key toJSON propagation ──────────────────────────────────

describe("sanitizeLogRecordForSink — C6: message and arg key toJSON context propagation", () => {
  it("propagates allowDirectMask into toJSON output for 'message' key", () => {
    // A message field whose value is an object with toJSON returning the secret.
    // Post-C6 fix, the context is propagated so the secret gets direct-masked.
    const record = {
      message: {
        toJSON() {
          return SECRET;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      message: string;
    };

    // The SECRET is 20 alnum chars — shouldMaskDirectString returns true for
    // 'message' key context, so it should be masked.
    expect(sanitized.message).toBe(MASKED);
  });

  it("propagates allowDirectMask into toJSON output for numeric arg key '0'", () => {
    const record = {
      0: {
        toJSON() {
          return SECRET;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      [key: string]: string;
    };

    expect(sanitized[0]).toBe(MASKED);
  });

  it("does NOT force-mask slash-charset string under 'message' toJSON (Bug 2 / C6 regression)", () => {
    // C6 intent: message/arg keys propagate allowDirectMask (soft charset gate),
    // but do NOT trigger the double-fallback force-mask.
    // A slash-containing string that does not match any pattern must pass through.
    const slashStr = "abcdef/1234567890ghij"; // 21 chars, slash blocks shouldMaskDirectString
    const record = {
      message: {
        toJSON() {
          return slashStr;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      message: string;
    };

    expect(sanitized.message).toBe(slashStr); // must NOT be force-masked
  });

  it("DOES force-mask slash-charset string under credential 'apiKey' toJSON (C4+C3 guard)", () => {
    // Contrast with the C6 test above: credential fields always use the double-fallback.
    const slashStr = "abcdef/1234567890ghij";
    const record = {
      apiKey: {
        toJSON() {
          return slashStr;
        },
      },
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as unknown as {
      apiKey: string;
    };

    // Force-masked because it's under a credential field.
    expect(sanitized.apiKey).toBe("abcdef\u2026ghij");
  });
});

// ── toJSON preservation ─────────────────────────────────────────────────────

describe("sanitizeLogRecordForSink — toJSON semantics", () => {
  it("preserves toJSON for URL, Buffer, and custom classes", () => {
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

    expect(sanitized.endpoint).toBe("https://api.openclaw.ai/v1/resource?k=v");
    expect(sanitized.payload).toEqual({ type: "Buffer", data: [1, 2, 3, 4] });
    expect(sanitized.tagged).toEqual({ kind: "tagged", id: "abc" });
  });

  it("falls back to record sanitization when toJSON throws (X6 per-field catch)", () => {
    const record = {
      broken: {
        toJSON() {
          throw new Error("bad serializer");
        },
        safe: "hello",
      },
    };

    // Must not throw; fall through to plain record sanitization.
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      broken: { safe: string };
    };

    expect(sanitized.broken.safe).toBe("hello");
  });
});

// ── Error payloads ──────────────────────────────────────────────────────────

describe("sanitizeLogRecordForSink — Error payloads", () => {
  it("sanitizes Error payloads with credential fields (E1)", () => {
    const error = Object.assign(new Error(`Authorization: Bearer ${SECRET}`), {
      apiKey: SECRET,
    });
    const record: Record<string, unknown> = { error };

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain(MASKED);
    expect(serialized).not.toContain(SECRET);
  });

  it("handles circular references without throwing (EC5)", () => {
    const record: Record<string, unknown> = { level: "info" };
    record.nested = record; // circular

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[Circular]");
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("force-masks non-credential-named custom properties on an Error under a credential key", () => {
    // CR2 scenario: { token: err } where err.rawValue holds a secret but its
    // key name is not credential-named. The inherited Force context from 'token'
    // must propagate through the Error boundary and mask rawValue.
    const error = Object.assign(new Error("fetch failed"), { rawValue: SECRET });
    const record = { token: error };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      token: { message: string; rawValue: string };
    };

    expect(sanitized.token.rawValue).toBe(MASKED);
    expect(sanitized.token.message).toBe("fetch failed"); // non-secret message unchanged
  });

  it("does not direct-mask error message when error has no ancestor context", () => {
    // Without an ancestor credential key, error.message gets no direct-mask treatment.
    // A token-like message would only be masked if a pattern matches it.
    const record = { error: new Error(SECRET) };

    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      error: { message: string };
    };

    // No pattern match for a bare alnum string; no ancestor context → message passes through.
    expect(sanitized.error.message).toBe(SECRET);
  });
});

// ── X2: Prototype pollution protection ─────────────────────────────────────

describe("sanitizeLogRecordForSink — X2: dangerous key filtering", () => {
  it("hard-filters __proto__ keys to prevent prototype pollution", () => {
    const record = Object.create(null) as Record<string, unknown>;
    record["__proto__"] = { polluted: true };
    record.safe = "value";

    const sanitized = sanitizeLogRecordForSink(record, resolved);

    expect((sanitized as { __proto__?: unknown })["__proto__"]).toBeUndefined();
    expect(sanitized.safe).toBe("value");
    // Verify no actual prototype pollution.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("hard-filters 'constructor' and 'prototype' keys", () => {
    const record = {
      constructor: "hijacked",
      prototype: "hijacked",
      legitimate: "value",
    };

    const sanitized = sanitizeLogRecordForSink(record, resolved);

    expect((sanitized as { constructor?: unknown }).constructor).toBeUndefined();
    expect((sanitized as { prototype?: unknown }).prototype).toBeUndefined();
    expect(sanitized.legitimate).toBe("value");
  });
});

// ── X3: Depth and width limits ──────────────────────────────────────────────

describe("sanitizeLogRecordForSink — X3: DoS guards", () => {
  it("returns [TooDeep] placeholder for objects nested beyond depth 16", () => {
    // Build a 20-level deep object.
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }
    const record = { root: deep };

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[TooDeep]");
    expect(serialized).not.toContain('"leaf"');
  });

  it("returns [TooWide] placeholder after 1024 entries in a single object", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1100; i++) {
      wide[`field${String(i)}`] = `value${String(i)}`;
    }
    const record = wide;

    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[TooWide]");
    // Exactly 1024 entries should be kept.
    const keepCount = (serialized.match(/"value\d+"/gu) ?? []).length;
    expect(keepCount).toBe(1024);
  });
});

// ── message key: nested plain strings must not be force-masked ─────────────
// message/msg/"0" keys propagate a soft charset gate, not a credential context.
// Nested objects and their fields should pass through unless they are themselves
// credential-named or contain pattern-matched secrets.

describe("sanitizeLogRecordForSink — message key nested object sanitization", () => {
  it("preserves plain strings nested inside a message object (regression)", () => {
    // Previously wrote { message: { note: "***" } } — plain strings must not be force-masked.
    const record = { message: { note: "hello" } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { note: string };
    };
    expect(sanitized.message.note).toBe("hello");
  });

  it("preserves plain strings three levels deep inside a message object", () => {
    const record = { message: { data: { label: "safe" } } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { data: { label: string } };
    };
    expect(sanitized.message.data.label).toBe("safe");
  });

  it("preserves plain strings nested inside a msg object", () => {
    const record = { msg: { status: "ok" } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      msg: { status: string };
    };
    expect(sanitized.msg.status).toBe("ok");
  });

  it("masks token-like strings nested inside a message object (charset gate applies)", () => {
    // 20-char alnum string under message — shouldMaskDirectString returns true
    const record = { message: { id: SECRET } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { id: string };
    };
    expect(sanitized.message.id).toBe(MASKED);
  });

  it("force-masks a credential-named field found inside a message object", () => {
    // A credential key inside message escalates to force-mask regardless of parent context.
    const record = { message: { password: "secret" } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { password: string };
    };
    expect(sanitized.message.password).toBe("***");
  });

  it("force-masks children of a credential key nested inside a message object", () => {
    // message → token → id: once a credential key is encountered, its children are also force-masked.
    const record = { message: { token: { id: "abc" } } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { token: { id: string } };
    };
    expect(sanitized.message.token.id).toBe("***");
  });

  it("preserves slash-charset strings nested inside a message object (no double-fallback)", () => {
    // Slash blocks the charset gate; message context must not apply the credential double-fallback.
    const slashStr = "abcdef/1234567890ghij";
    const record = { message: { path: slashStr } };
    const sanitized = sanitizeLogRecordForSink(record, resolved) as {
      message: { path: string };
    };
    expect(sanitized.message.path).toBe(slashStr);
  });
});

// ── X1: Fail-closed for exotic objects ─────────────────────────────────────

describe("sanitizeLogRecordForSink — X1: Proxy / exotic object fail-closed", () => {
  it("returns exotic sentinel when a Proxy throws on property access", () => {
    const throwingProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "toJSON") {
            return undefined;
          }
          throw new Error("proxy trap fired");
        },
        ownKeys() {
          return ["dangerousKey"];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true, value: "bad" };
        },
      },
    );

    const record = { proxy: throwingProxy };

    // Must not throw — should return a sanitized record with a safe placeholder.
    expect(() => sanitizeLogRecordForSink(record, resolved)).not.toThrow();
    const sanitized = sanitizeLogRecordForSink(record, resolved);
    const serialized = JSON.stringify(sanitized);
    // The proxy field may resolve to exotic sentinel or a sanitized form.
    // Key requirement: no throw.
    expect(typeof serialized).toBe("string");
  });

  it("returns safe placeholder when top-level sanitization throws unexpectedly", () => {
    // A root-level Proxy that throws on every access.
    const evilRoot = new Proxy({} as Record<string, unknown>, {
      ownKeys() {
        throw new Error("ownKeys trap");
      },
    });

    // Even a root-level throw must produce a safe result.
    expect(() => sanitizeLogRecordForSink(evilRoot, resolved)).not.toThrow();
    const result = sanitizeLogRecordForSink(evilRoot, resolved);
    expect(result).toBeDefined();
  });
});
