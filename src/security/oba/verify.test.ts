import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "./base64url.js";
import { canonicalize, CanonicalizeError } from "./canonicalize.js";
import { classifyObaOffline } from "./extract.js";
import { clearJwksCache, mapLimit, verifyObaContainer } from "./verify.js";

// --- helpers: generate an Ed25519 keypair + JWK in-test ---

function makeTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
  };
  return {
    publicKey,
    privateKey,
    jwk: { ...jwk, kid: "test-kid", use: "sig" as const },
  };
}

function signContainer(container: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const clone = structuredClone(container);
  const oba = clone.oba as Record<string, unknown> | undefined;
  if (oba) {
    delete oba.sig;
  }
  const payload = Buffer.from(canonicalize(clone), "utf-8");
  const sig = crypto.sign(null, payload, privateKey);
  return base64UrlEncode(sig);
}

// --- tests ---

describe("canonicalize", () => {
  it("produces deterministic output with sorted keys", () => {
    const a = canonicalize({ b: 2, a: 1 });
    const b = canonicalize({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it("handles nested objects and arrays", () => {
    const result = canonicalize({ z: [3, 1], a: { c: true, b: "hi" } });
    expect(result).toBe('{"a":{"b":"hi","c":true},"z":[3,1]}');
  });

  it("rejects undefined values at top level", () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalizeError);
  });

  it("rejects BigInt", () => {
    expect(() => canonicalize({ n: BigInt(42) })).toThrow(CanonicalizeError);
  });

  it("rejects functions", () => {
    expect(() => canonicalize({ fn: () => {} })).toThrow(CanonicalizeError);
  });

  it("rejects symbols", () => {
    expect(() => canonicalize({ s: Symbol("x") })).toThrow(CanonicalizeError);
  });

  it("skips undefined object values (matches JSON.stringify)", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("replaces undefined array elements with null", () => {
    // eslint-disable-next-line no-sparse-arrays
    const result = canonicalize([1, undefined, 3]);
    expect(result).toBe("[1,null,3]");
  });
});

describe("classifyObaOffline", () => {
  it("returns unsigned for absent oba", () => {
    const result = classifyObaOffline(undefined);
    expect(result.verification.status).toBe("unsigned");
    expect(result.oba).toBeUndefined();
  });

  it("returns unsigned for null oba", () => {
    const result = classifyObaOffline(null);
    expect(result.verification.status).toBe("unsigned");
  });

  it("returns signed for well-formed oba", () => {
    const result = classifyObaOffline({
      owner: "https://example.com/.well-known/jwks.json",
      kid: "k1",
      alg: "EdDSA",
      sig: "abc123",
    });
    expect(result.verification.status).toBe("signed");
    expect(result.oba).toBeDefined();
    expect(result.verification.ownerUrl).toBe("https://example.com/.well-known/jwks.json");
  });

  it("returns invalid for malformed oba (not an object)", () => {
    const result = classifyObaOffline("not-an-object");
    expect(result.verification.status).toBe("invalid");
    expect(result.verification.reason).toContain("malformed oba block");
    expect(result.oba).toBeUndefined();
  });

  it("returns invalid for missing owner", () => {
    const result = classifyObaOffline({ kid: "k1", alg: "EdDSA", sig: "abc" });
    expect(result.verification.status).toBe("invalid");
    expect(result.verification.reason).toContain("owner");
  });

  it("returns invalid for wrong alg", () => {
    const result = classifyObaOffline({
      owner: "https://example.com",
      kid: "k1",
      alg: "RS256",
      sig: "abc",
    });
    expect(result.verification.status).toBe("invalid");
    expect(result.verification.reason).toContain("alg");
  });
});

describe("mapLimit", () => {
  it("maps items with concurrency limit", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapLimit(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("preserves result order regardless of completion order", async () => {
    const items = [3, 1, 2]; // delays in ms
    const results = await mapLimit(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, n * 10));
      return n;
    });
    expect(results).toEqual([3, 1, 2]);
  });

  it("handles empty array", async () => {
    const results = await mapLimit([], 4, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await mapLimit(items, 2, async (n) => {
      running++;
      if (running > maxRunning) {
        maxRunning = running;
      }
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return n;
    });

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("propagates errors from fn", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error("fail");
        }
        return n;
      }),
    ).rejects.toThrow("fail");
  });

  it("works when limit exceeds item count", async () => {
    const results = await mapLimit([1, 2], 10, async (n) => n * 2);
    expect(results).toEqual([2, 4]);
  });
});

describe("verifyObaContainer", () => {
  let kp: ReturnType<typeof makeTestKeyPair>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    kp = makeTestKeyPair();
    clearJwksCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearJwksCache();
  });

  function mockFetch(jwk: Record<string, unknown>) {
    const body = JSON.stringify({ keys: [jwk] });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      }),
    ) as unknown as typeof fetch;
  }

  it("returns unsigned when no oba block", async () => {
    const container = { id: "my-plugin", configSchema: {} };
    const result = await verifyObaContainer(container);
    expect(result.status).toBe("unsigned");
  });

  it("returns invalid for malformed oba block", async () => {
    const container = { id: "my-plugin", oba: { owner: 123 } };
    const result = await verifyObaContainer(container as Record<string, unknown>);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("malformed oba block");
  });

  it("verifies a correctly signed container", async () => {
    mockFetch(kp.jwk);

    const container: Record<string, unknown> = {
      id: "my-plugin",
      configSchema: {},
      oba: {
        owner: "https://example.com/.well-known/jwks.json",
        kid: "test-kid",
        alg: "EdDSA",
        sig: "",
      },
    };

    // Sign it
    const sig = signContainer(container, kp.privateKey);
    (container.oba as Record<string, unknown>).sig = sig;

    const result = await verifyObaContainer(container);
    expect(result.status).toBe("verified");
    expect(result.ownerUrl).toBe("https://example.com/.well-known/jwks.json");
  });

  it("returns invalid when a field is tampered", async () => {
    mockFetch(kp.jwk);

    const container: Record<string, unknown> = {
      id: "my-plugin",
      configSchema: {},
      oba: {
        owner: "https://example.com/.well-known/jwks.json",
        kid: "test-kid",
        alg: "EdDSA",
        sig: "",
      },
    };

    const sig = signContainer(container, kp.privateKey);
    (container.oba as Record<string, unknown>).sig = sig;

    // Tamper
    container.id = "tampered-plugin";

    const result = await verifyObaContainer(container);
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature mismatch");
  });

  it("returns invalid when kid is not found in JWKS", async () => {
    const otherJwk = { ...kp.jwk, kid: "different-kid" };
    mockFetch(otherJwk);

    const container: Record<string, unknown> = {
      id: "my-plugin",
      oba: {
        owner: "https://example.com/.well-known/jwks.json",
        kid: "test-kid",
        alg: "EdDSA",
        sig: "",
      },
    };
    const sig = signContainer(container, kp.privateKey);
    (container.oba as Record<string, unknown>).sig = sig;

    const result = await verifyObaContainer(container);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("key not found");
  });

  it("returns invalid when JWKS fetch fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network error")) as unknown as typeof fetch;

    const container: Record<string, unknown> = {
      id: "my-plugin",
      oba: {
        owner: "https://example.com/.well-known/jwks.json",
        kid: "test-kid",
        alg: "EdDSA",
        sig: "abc",
      },
    };

    const result = await verifyObaContainer(container);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("jwks fetch failed");
  });
});
