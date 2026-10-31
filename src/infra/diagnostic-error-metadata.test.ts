import { describe, expect, it } from "vitest";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
  diagnosticHttpStatusCode,
  diagnosticProviderRequestIdHash,
} from "./diagnostic-error-metadata.js";

function throwingGetter(): never {
  throw new Error("should not read getter");
}

function withThrowingGetters(...keys: string[]): object {
  return Object.create(null, Object.fromEntries(keys.map((key) => [key, { get: throwingGetter }])));
}

describe("diagnostic error metadata", () => {
  it("returns stable categories without reading mutable Error.name", () => {
    const namedFailure = new Error("bad");
    Object.defineProperty(namedFailure, "name", { get: throwingGetter });

    expect(diagnosticErrorCategory(new TypeError("bad"))).toBe("TypeError");
    expect(diagnosticErrorCategory(namedFailure)).toBe("Error");
    expect(diagnosticErrorCategory("bad")).toBe("string");
    expect(diagnosticErrorCategory(null)).toBe("null");
  });

  it("normalizes Error and string messages", () => {
    expect(diagnosticErrorMessage(new Error("  provider failed  "))).toBe("provider failed");
    expect(diagnosticErrorMessage("  connection closed  ")).toBe("connection closed");
    expect(diagnosticErrorMessage("   ")).toBeUndefined();
  });

  it.each([
    ["message", diagnosticErrorMessage, ["message"]],
    ["status", diagnosticHttpStatusCode, ["status"]],
    ["request id", diagnosticProviderRequestIdHash, ["requestId"]],
    ["failure kind", diagnosticErrorFailureKind, ["code", "message"]],
  ] as const)("does not invoke %s getters", (_name, extract, keys) => {
    expect(extract(withThrowingGetters(...keys))).toBeUndefined();
  });

  it("accepts only own HTTP status data properties as error codes", () => {
    expect(diagnosticHttpStatusCode({ status: 429 })).toBe("429");
    expect(diagnosticHttpStatusCode({ statusCode: 503 })).toBe("503");
    expect(diagnosticHttpStatusCode({ code: "SECRET_TOKEN" })).toBeUndefined();
    expect(diagnosticHttpStatusCode({ status: 99 })).toBeUndefined();
    expect(diagnosticHttpStatusCode({ status: "https://example.invalid/secret" })).toBeUndefined();
  });

  it("contains proxy traps during extraction", () => {
    const errorLike = new Proxy({}, { getOwnPropertyDescriptor: throwingGetter });
    expect(diagnosticHttpStatusCode(errorLike)).toBeUndefined();
  });

  it("extracts bounded provider request id hashes without exposing raw ids", () => {
    for (const error of [
      { requestId: "req_123" },
      new Error("Provider API error (429): quota [request_id=req_456]"),
    ]) {
      expect(diagnosticProviderRequestIdHash(error)).toMatch(/^sha256:[a-f0-9]{12}$/);
    }
    expect(
      diagnosticProviderRequestIdHash({ requestId: "https://example.invalid/secret" }),
    ).toBeUndefined();
  });

  it("classifies low-cardinality transport failure kinds without exposing messages", () => {
    expect(diagnosticErrorFailureKind(new Error("terminated"))).toBe("terminated");
    expect(
      diagnosticErrorFailureKind(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    ).toBe("connection_reset");
    expect(
      diagnosticErrorFailureKind({
        error: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ).toBe("connection_closed");
    expect(diagnosticErrorFailureKind(new Error("request timed out after 120000ms"))).toBe(
      "timeout",
    );
    expect(diagnosticErrorFailureKind(new Error("operation was aborted"))).toBe("aborted");
    expect(diagnosticErrorFailureKind(new Error("provider rejected the request"))).toBeUndefined();
  });
});
