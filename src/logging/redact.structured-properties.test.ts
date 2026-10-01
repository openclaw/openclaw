import { describe, expect, it, vi } from "vitest";
import * as configRegex from "../security/config-regex.js";
import { applyLoggingConfig, resetLogger } from "./logger.js";
import { redactModelVisibleSecrets, redactSecrets } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

describe.each([redactSecrets, redactModelVisibleSecrets])("%s structured properties", (redact) => {
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
    expect(result.first).not.toBe(result.second);
    expect(shared.token).toBe("fixture-value");
  });

  it("prepares custom patterns once per used policy for a structured invocation", () => {
    const input = Array.from({ length: 128 }, (_, index) => ({
      detail: `internal-${index}`,
      apiKey: `internal-${index + 128}`,
    }));
    const before = JSON.stringify(input);
    const compile = vi.spyOn(configRegex, "compileConfigRegex");
    const preparations = () =>
      compile.mock.calls.filter(
        ([source, flags]) => source === String.raw`internal-\d+` && flags === "g",
      ).length;
    let positiveControl: unknown;
    let positivePreparations = 0;
    let result: unknown;
    let preparationCount = 0;
    try {
      applyLoggingConfig({ redactPatterns: [String.raw`/internal-\d+/g`] });
      positiveControl = redact({ detail: "internal-0" });
      positivePreparations = preparations();
      compile.mockClear();
      result = redact(input);
      preparationCount = preparations();
    } finally {
      compile.mockRestore();
      resetLogger();
    }

    expect(positiveControl).toEqual({ detail: "***" });
    expect(positivePreparations).toBe(1);
    expect(result).toEqual(input.map(() => ({ detail: "***", apiKey: "***" })));
    expect(JSON.stringify(input)).toBe(before);
    expect(preparationCount).toBe(redact === redactSecrets ? 1 : 2);
  });

  it("keeps captured patterns while later leaves see registry updates and nested calls see new config", () => {
    const input = [
      { detail: "internal-1 external-1 later-secret" },
      { detail: "internal-2 external-2 later-secret" },
    ];
    const nested: unknown[] = [];
    Object.defineProperty(input, 1, {
      enumerable: true,
      get() {
        registerSecretValueForRedaction("later-secret");
        applyLoggingConfig({ redactPatterns: [String.raw`/external-\d+/g`] });
        nested.push(redact({ detail: "internal-3 external-3 later-secret" }));
        return { detail: "internal-2 external-2 later-secret" };
      },
    });
    let result: unknown;
    let next: unknown;
    try {
      applyLoggingConfig({ redactPatterns: [String.raw`/internal-\d+/g`] });
      result = redact(input);
      next = redact({ detail: "internal-4 external-4 later-secret" });
    } finally {
      resetLogger();
      resetSecretRedactionRegistryForTest();
    }

    expect(result).toEqual([
      { detail: "*** external-1 later-secret" },
      { detail: "*** external-2 ***" },
    ]);
    expect(nested).toEqual([{ detail: "internal-3 *** ***" }]);
    expect(next).toEqual({ detail: "internal-4 *** ***" });
    expect(input[0]).toEqual({ detail: "internal-1 external-1 later-secret" });
  });
});
