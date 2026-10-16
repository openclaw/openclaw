import crypto, { type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOfficialExternalPluginCatalogSignedEnvelope } from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

const PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

type SigningKey = {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

function fixtureFeed(): OfficialExternalPluginCatalogFeed {
  return {
    schemaVersion: 2,
    id: "clawhub-official",
    generatedAt: "2026-06-30T00:00:00.000Z",
    sequence: 42,
    entries: [
      {
        type: "plugin",
        id: "@openclaw/signed-feed-proof",
        title: "Signed Feed Proof",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
      },
    ],
  };
}

function createSigningKey(keyId: string): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { keyId, privateKey, publicKey };
}

function expectVerification(
  envelope: unknown,
  keys: SigningKey[],
  expected: object | string,
  options: { threshold?: number; allowLegacyBetaEnvelope?: boolean } = {},
) {
  expect(
    verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: keys.map((key) => ({
        keyId: key.keyId,
        publicKey: key.publicKey.export({ type: "spki", format: "pem" }),
      })),
      ...options,
    }),
  ).toMatchObject(typeof expected === "string" ? { ok: false, error: expected } : expected);
}

function signingInput(payloadType: string, payloadBytes: Buffer): Buffer {
  const payloadTypeBytes = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${payloadTypeBytes.length} ${payloadType} ${payloadBytes.length} `, "utf8"),
    payloadBytes,
  ]);
}

function signedEnvelope(params: {
  keys: readonly SigningKey[];
  feed?: unknown;
  payloadType?: string;
  encoding?: "base64" | "base64url";
}) {
  const payloadType = params.payloadType ?? PAYLOAD_TYPE;
  const payloadBytes = Buffer.from(JSON.stringify(params.feed ?? fixtureFeed()), "utf8");
  const payload = payloadBytes.toString(params.encoding ?? "base64url");
  const input = signingInput(payloadType, payloadBytes);
  return {
    payloadType,
    payload,
    signatures: params.keys.map((key) => ({
      keyid: key.keyId,
      sig: crypto.sign(null, input, key.privateKey).toString("base64url"),
    })),
  };
}

describe("official external plugin catalog signed envelopes", () => {
  it("enforces distinct trusted key material for signature thresholds", () => {
    const first = createSigningKey("first");
    const second = createSigningKey("second");
    expectVerification(
      signedEnvelope({ keys: [first, second] }),
      [first, second],
      {
        ok: true,
        signedByKeyIds: ["first", "second"],
        signatureCount: 2,
        threshold: 2,
      },
      { threshold: 2 },
    );
    const duplicate = { ...first, keyId: "duplicate-material" };
    expectVerification(
      signedEnvelope({ keys: [first, duplicate] }),
      [first, duplicate],
      "invalid-signature",
      { threshold: 2 },
    );
  });

  it("rejects payload bytes changed after signing", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    envelope.payload = Buffer.from(
      JSON.stringify({ ...fixtureFeed(), sequence: 43 }),
      "utf8",
    ).toString("base64url");
    expectVerification(envelope, [key], "invalid-signature");
  });

  it("distinguishes unknown keys from invalid trusted signatures", () => {
    const signer = createSigningKey("signer");
    const other = createSigningKey("other");
    const envelope = signedEnvelope({ keys: [signer] });
    expectVerification(envelope, [other], "missing-trust-key");
    expectVerification(envelope, [{ ...other, keyId: signer.keyId }], "invalid-signature");
  });

  it("rejects duplicate key ids and excessive signature lists", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expectVerification(
      { ...envelope, signatures: [signature, signature] },
      [key],
      "invalid-envelope",
    );
    expectVerification(
      {
        ...envelope,
        signatures: Array.from({ length: 17 }, (_, index) => ({
          ...signature,
          keyid: `key-${index}`,
        })),
      },
      [key],
      "invalid-envelope",
    );
  });

  it("rejects unsupported payload types and signed invalid feeds", () => {
    const key = createSigningKey("catalog-root");
    expectVerification(
      signedEnvelope({ keys: [key], payloadType: "example.unsupported" }),
      [key],
      "unsupported-payload",
    );
    expectVerification(signedEnvelope({ keys: [key], feed: { entries: [] } }), [key], {
      ok: false,
      error: "invalid-payload",
      authenticatedPayload: { entries: [] },
    });
  });

  it("rejects malformed envelopes before verification", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expect(signature).toBeDefined();
    if (!signature) {
      throw new Error("expected a generated signature");
    }
    expectVerification(
      { payloadType: PAYLOAD_TYPE, payload: "", signatures: [] },
      [],
      "invalid-envelope",
    );
    expectVerification(
      { ...envelope, signatures: [{ sig: signature.sig }] },
      [key],
      "invalid-envelope",
    );
  });

  it("accepts beta legacy field names only for persisted snapshots", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expect(signature).toBeDefined();
    if (!signature) {
      throw new Error("expected a generated signature");
    }
    const legacySignature = {
      keyId: signature.keyid,
      algorithm: "ed25519",
      signature: signature.sig,
    };
    const legacyEnvelope = { ...envelope, schemaVersion: 1, signatures: [legacySignature] };
    expectVerification(legacyEnvelope, [key], "invalid-envelope");
    expectVerification(
      legacyEnvelope,
      [key],
      { ok: true, signedBy: key.keyId },
      { allowLegacyBetaEnvelope: true },
    );
    const mixedEnvelope = {
      ...envelope,
      schemaVersion: 1,
      signatures: [signature, legacySignature],
    };
    expectVerification(mixedEnvelope, [key], "invalid-envelope");
    expectVerification(mixedEnvelope, [key], "invalid-envelope", { allowLegacyBetaEnvelope: true });
  });
});
