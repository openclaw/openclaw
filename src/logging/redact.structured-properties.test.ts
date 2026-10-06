import { describe, expect, it, vi } from "vitest";
import { redactLogRecordForTransport, redactModelVisibleSecrets, redactSecrets } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

function observePrefilterProbes(text: string) {
  const probe = vi.spyOn(RegExp.prototype, "test");
  return {
    count: () =>
      probe.mock.contexts.filter(
        (pattern, index) =>
          pattern instanceof RegExp &&
          pattern.source.startsWith("(?:KEY|TOKEN|SECRET|") &&
          probe.mock.calls[index]?.[0] === text,
      ).length,
    restore: () => probe.mockRestore(),
  };
}

it.each([redactSecrets, redactModelVisibleSecrets, redactLogRecordForTransport])(
  "%s reuses scalar probes only within the current record and preserves field protection",
  (redact) => {
    const log = redact === redactLogRecordForTransport;
    const text = log ? "ordinary repeated log fixture 🦞" : "ordinary repeated fixture 🦞";
    const record = { detail: text, nested: { detail: text }, ...(log ? {} : { token: text }) };
    const probe = observePrefilterProbes(text);
    try {
      expect(redact(record)).toEqual({ ...record, ...(log ? {} : { token: "ordina…e 🦞" }) });
      expect(probe.count()).toBe(1);
      const next = log ? record : { detail: text };
      expect(redact(next)).toEqual(next);
      expect(probe.count()).toBe(2);
    } finally {
      probe.restore();
    }
  },
);

describe.each([redactSecrets, redactModelVisibleSecrets])("%s structured properties", (redact) => {
  it("uses current registry masking before reusing an exact text probe", () => {
    const text = "opaque-fixture-value";
    const input = [{ detail: text }, { detail: text }];
    Object.defineProperty(input, 1, {
      get() {
        registerSecretValueForRedaction(text);
        return { detail: text };
      },
    });
    try {
      expect(redact(input)).toEqual([{ detail: text }, { detail: "opaque…alue" }]);
    } finally {
      resetSecretRedactionRegistryForTest();
    }
  });

  it("redacts public share capabilities without treating ordinary ids as secrets", () => {
    const shareId = "a".repeat(48);
    expect(
      redact({
        publicShare: { id: shareId, sessionId: "session-1", createdAt: 1 },
        ordinary: { id: shareId },
      }),
    ).toEqual({
      publicShare: { id: "aaaaaa…aaaa", sessionId: "session-1", createdAt: 1 },
      ordinary: { id: shareId },
    });
  });

  it("preserves JSON prototype-named fields as redacted own data", () => {
    const input = JSON.parse(
      '{"__proto__":{"label":"root","token":"fixture-value"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    const before = JSON.stringify(input);
    const result = redact(input);

    expect(JSON.stringify(result)).toBe(
      '{"__proto__":{"label":"root","token":"***"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    for (const value of [result, result.nested, ...result.items]) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps shared references distinct from cycles and preserves nonplain values", () => {
    const shared = { label: "ordinary", token: "fixture-value" };
    const input: Record<string, unknown> = Object.assign(Object.create(null), {
      first: shared,
      second: shared,
      date: new Date(0),
    });
    input.self = input;
    const result = redact(input);

    expect(result).toEqual({
      first: { label: "ordinary", token: "***" },
      second: { label: "ordinary", token: "***" },
      date: input.date,
      self: "[Circular]",
    });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.date).toBe(input.date);
    expect(result.first).not.toBe(shared);
    expect(shared.token).toBe("fixture-value");
  });
});
