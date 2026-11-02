import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStreamSecretRedactor } from "../../scripts/lib/stream-secret-redaction.mts";
import { registerSecretValueForRedaction } from "../../src/logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../src/logging/secret-redaction-registry.test-support.js";

const sentinel = "fal-sentinel-not-a-real-key-0123456789";
const mask = (value: string) => `<redacted len=${value.length}>`;

beforeEach(resetSecretRedactionRegistryForTest);
afterEach(resetSecretRedactionRegistryForTest);

describe("stream secret redaction", () => {
  it("redacts a value split at every internal boundary", () => {
    registerSecretValueForRedaction(sentinel);
    for (let split = 1; split < sentinel.length; split++) {
      const redactor = createStreamSecretRedactor(mask);
      expect(redactor.push(`before:${sentinel.slice(0, split)}`), `split ${split}`).toBe("before:");
      expect(redactor.push(`${sentinel.slice(split)}:after`), `split ${split}`).toBe(
        `${mask(sentinel)}:after`,
      );
      expect(redactor.end()).toBe("");
    }
  });

  it("redacts a multiline value written one line at a time", () => {
    const value = "multiline-not-a-real-secret\nsecond-synthetic-line\nlast-synthetic-line";
    registerSecretValueForRedaction(value);
    const redactor = createStreamSecretRedactor(mask);
    expect(redactor.push("multiline-not-a-real-secret\n")).toBe("");
    expect(redactor.push("second-synthetic-line\n")).toBe("");
    expect(redactor.push("last-synthetic-line")).toBe(mask(value));
    expect(redactor.end()).toBe("");
  });

  it("redacts a value spanning a large newline-free buffer", () => {
    registerSecretValueForRedaction(sentinel);
    const redactor = createStreamSecretRedactor(mask);
    const prefix = "x".repeat(64 * 1024 + 17);
    const split = Math.floor(sentinel.length / 2);
    expect(redactor.push(prefix + sentinel.slice(0, split))).toBe(prefix);
    expect(redactor.push(`${sentinel.slice(split)}:done`)).toBe(`${mask(sentinel)}:done`);
    expect(redactor.end()).toBe("");
  });

  it("immediately emits output without a possible secret prefix tail", () => {
    registerSecretValueForRedaction(sentinel);
    const redactor = createStreamSecretRedactor(mask);
    expect(redactor.push("ready>\n")).toBe("ready>\n");
    expect(redactor.end()).toBe("");
  });

  it("releases an incomplete prefix with the next output or at end", () => {
    registerSecretValueForRedaction(sentinel);
    const prefix = sentinel.slice(0, 12);
    const redactor = createStreamSecretRedactor(mask);
    expect(redactor.push(`visible:${prefix}`)).toBe("visible:");
    expect(redactor.push("!")).toBe(`${prefix}!`);
    expect(redactor.end()).toBe("");

    const ending = createStreamSecretRedactor(mask);
    expect(ending.push(prefix)).toBe("");
    expect(ending.end()).toBe(prefix);
    expect(ending.end()).toBe("");
  });

  it("redacts a URL-encoded surface form split inside an escape", () => {
    const value = "synthetic secret/with a 'quote'?=not-real";
    registerSecretValueForRedaction(value);
    const encoded = encodeURIComponent(value);
    const split = encoded.indexOf("%") + 1;
    const redactor = createStreamSecretRedactor(mask);
    expect(redactor.push(encoded.slice(0, split))).toBe("");
    expect(redactor.push(encoded.slice(split))).toBe(mask(encoded));
    expect(redactor.end()).toBe("");
  });

  it("keeps a complete match intact when another value's prefix would split it", () => {
    registerSecretValueForRedaction(sentinel);
    registerSecretValueForRedaction(`${sentinel.slice(-6)}-another-not-real-secret`);
    const redactor = createStreamSecretRedactor(mask);
    expect(redactor.push(sentinel)).toBe("");
    expect(redactor.push(":")).toBe(`${mask(sentinel)}:`);
    expect(redactor.end()).toBe("");
  });
});
