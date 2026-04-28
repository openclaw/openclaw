import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./zod-schema.core.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

describe("normalizeAllowFrom with SecretRef entries", () => {
  it("filters out SecretRef objects and keeps plain strings", () => {
    const result = normalizeAllowFrom(["+15550001234", envRef("PHONE"), "+15550005678"]);
    expect(result).toEqual(["+15550001234", "+15550005678"]);
  });

  it("filters out env-template SecretRef strings and keeps plain strings", () => {
    const result = normalizeAllowFrom(["+15550001234", "plaintext"]);
    expect(result).toEqual(["+15550001234", "plaintext"]);
  });

  it("returns empty array when all entries are SecretRefs", () => {
    const result = normalizeAllowFrom([envRef("A"), envRef("B")]);
    expect(result).toEqual([]);
  });

  it("handles undefined input", () => {
    expect(normalizeAllowFrom(undefined)).toEqual([]);
  });

  it("handles mixed numbers, strings, and SecretRefs", () => {
    const result = normalizeAllowFrom([42, envRef("SECRET"), "ok"]);
    expect(result).toEqual(["42", "ok"]);
  });
});
