import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  type HookSignatureProvider,
  resolveSignatureProviders,
  verifyHmacSignature,
  verifyHookSignature,
} from "./hooks-signature.js";

function computeHmac(algorithm: string, secret: string, body: string, encoding: "hex"): string {
  return createHmac(algorithm, secret).update(body).digest(encoding);
}

describe("hooks-signature", () => {
  const secret = "test-webhook-secret";
  const body = '{"action":"push","ref":"refs/heads/main"}';

  describe("verifyHmacSignature", () => {
    test("valid sha256 hex signature", () => {
      const sig = computeHmac("sha256", secret, body, "hex");
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: sig,
          algorithm: "sha256",
          secret,
          format: "hex",
        }),
      ).toBe(true);
    });

    test("valid sha1 hex signature", () => {
      const sig = computeHmac("sha1", secret, body, "hex");
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: sig,
          algorithm: "sha1",
          secret,
          format: "hex",
        }),
      ).toBe(true);
    });

    test("valid sha256 prefixed signature (GitHub-style)", () => {
      const sig = computeHmac("sha256", secret, body, "hex");
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: `sha256=${sig}`,
          algorithm: "sha256",
          secret,
          format: "prefixed",
        }),
      ).toBe(true);
    });

    test("invalid signature is rejected", () => {
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: "0000000000000000000000000000000000000000000000000000000000000000",
          algorithm: "sha256",
          secret,
          format: "hex",
        }),
      ).toBe(false);
    });

    test("wrong secret is rejected", () => {
      const sig = computeHmac("sha256", "wrong-secret", body, "hex");
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: sig,
          algorithm: "sha256",
          secret,
          format: "hex",
        }),
      ).toBe(false);
    });

    test("empty signature header is rejected", () => {
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: "",
          algorithm: "sha256",
          secret,
          format: "hex",
        }),
      ).toBe(false);
    });

    test("prefixed format with no equals sign is rejected", () => {
      expect(
        verifyHmacSignature({
          body,
          signatureHeader: "noseparator",
          algorithm: "sha256",
          secret,
          format: "prefixed",
        }),
      ).toBe(false);
    });

    test("modified body produces different signature", () => {
      const sig = computeHmac("sha256", secret, body, "hex");
      expect(
        verifyHmacSignature({
          body: body + " ",
          signatureHeader: sig,
          algorithm: "sha256",
          secret,
          format: "hex",
        }),
      ).toBe(false);
    });
  });

  describe("verifyHookSignature", () => {
    const githubProvider: HookSignatureProvider = {
      name: "github",
      header: "x-hub-signature-256",
      algorithm: "sha256",
      secret,
      format: "prefixed",
      timestampMaxAgeSeconds: 300,
    };

    const stripeProvider: HookSignatureProvider = {
      name: "stripe",
      header: "stripe-signature",
      algorithm: "sha256",
      secret: "stripe-secret",
      format: "hex",
      timestampHeader: "stripe-timestamp",
      timestampMaxAgeSeconds: 300,
    };

    test("verifies GitHub-style signature", () => {
      const sig = computeHmac("sha256", secret, body, "hex");
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "x-hub-signature-256": `sha256=${sig}` },
        providers: [githubProvider],
      });
      expect(result).toEqual({ ok: true, provider: "github" });
    });

    test("rejects invalid GitHub signature", () => {
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "x-hub-signature-256": "sha256=invalid" },
        providers: [githubProvider],
      });
      expect(result).toEqual({ ok: false, error: "signature verification failed" });
    });

    test("returns error when no matching header found", () => {
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "x-unrelated-header": "value" },
        providers: [githubProvider],
      });
      expect(result).toEqual({ ok: false, error: "no matching signature header found" });
    });

    test("returns error when no providers configured", () => {
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "x-hub-signature-256": "sha256=abc" },
        providers: [],
      });
      expect(result).toEqual({ ok: false, error: "no signature providers configured" });
    });

    test("selects matching provider from multiple", () => {
      const now = Math.floor(Date.now() / 1000);
      const sig = computeHmac("sha256", "stripe-secret", `${now}.${body}`, "hex");
      const result = verifyHookSignature({
        rawBody: body,
        headers: {
          "stripe-signature": sig,
          "stripe-timestamp": String(now),
        },
        providers: [githubProvider, stripeProvider],
      });
      expect(result).toEqual({ ok: true, provider: "stripe" });
    });

    test("rejects expired timestamp", () => {
      const sig = computeHmac("sha256", "stripe-secret", body, "hex");
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const result = verifyHookSignature({
        rawBody: body,
        headers: {
          "stripe-signature": sig,
          "stripe-timestamp": String(oldTimestamp),
        },
        providers: [stripeProvider],
      });
      expect(result).toEqual({ ok: false, error: "timestamp expired or invalid" });
    });

    test("rejects missing timestamp header when required", () => {
      const sig = computeHmac("sha256", "stripe-secret", body, "hex");
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "stripe-signature": sig },
        providers: [stripeProvider],
      });
      expect(result).toEqual({
        ok: false,
        error: "missing timestamp header: stripe-timestamp",
      });
    });

    test("accepts timestamp within window", () => {
      const now = Math.floor(Date.now() / 1000) - 100;
      const sig = computeHmac("sha256", "stripe-secret", `${now}.${body}`, "hex");
      const result = verifyHookSignature({
        rawBody: body,
        headers: {
          "stripe-signature": sig,
          "stripe-timestamp": String(now),
        },
        providers: [stripeProvider],
      });
      expect(result).toEqual({ ok: true, provider: "stripe" });
    });

    test("rejects replayed request with tampered timestamp", () => {
      const originalTs = Math.floor(Date.now() / 1000) - 400; // outside window
      const sig = computeHmac("sha256", "stripe-secret", `${originalTs}.${body}`, "hex");
      // Attacker replays with fresh timestamp but same body+sig
      const freshTs = Math.floor(Date.now() / 1000);
      const result = verifyHookSignature({
        rawBody: body,
        headers: {
          "stripe-signature": sig,
          "stripe-timestamp": String(freshTs),
        },
        providers: [stripeProvider],
      });
      expect(result).toEqual({ ok: false, error: "signature verification failed" });
    });

    test("provider without timestamp does not include timestamp in HMAC", () => {
      // GitHub-style provider has no timestampHeader, so HMAC is body-only
      const sig = computeHmac("sha256", secret, body, "hex");
      const result = verifyHookSignature({
        rawBody: body,
        headers: { "x-hub-signature-256": `sha256=${sig}` },
        providers: [githubProvider],
      });
      expect(result).toEqual({ ok: true, provider: "github" });
    });
  });

  describe("resolveSignatureProviders", () => {
    test("resolves with defaults", () => {
      const providers = resolveSignatureProviders({
        github: { header: "X-Hub-Signature-256", secret: "test-secret" },
      });
      expect(providers).toEqual([
        {
          name: "github",
          header: "x-hub-signature-256",
          algorithm: "sha256",
          secret: "test-secret",
          format: "hex",
          timestampHeader: undefined,
          timestampMaxAgeSeconds: 300,
        },
      ]);
    });

    test("resolves explicit values", () => {
      const providers = resolveSignatureProviders({
        stripe: {
          header: "Stripe-Signature",
          algorithm: "sha256",
          secret: "whsec_xxx",
          format: "prefixed",
          timestampHeader: "Stripe-Timestamp",
          timestampMaxAgeSeconds: 600,
        },
      });
      expect(providers).toEqual([
        {
          name: "stripe",
          header: "stripe-signature",
          algorithm: "sha256",
          secret: "whsec_xxx",
          format: "prefixed",
          timestampHeader: "stripe-timestamp",
          timestampMaxAgeSeconds: 600,
        },
      ]);
    });

    test("skips providers with empty secret", () => {
      const providers = resolveSignatureProviders({
        valid: { header: "x-sig", secret: "real-secret" },
        empty: { header: "x-sig2", secret: "" },
        whitespace: { header: "x-sig3", secret: "   " },
      });
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("valid");
    });
  });
});
