import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { verifyOfficialExternalPluginCatalogSignedEnvelope } from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

const PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

type SigningKey = ReturnType<typeof createSigningKey>;

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

function createSigningKey(keyId: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { keyId, privateKey, publicKey };
}

function expectVerification(
  envelope: unknown,
  expected: object | string,
  keys: SigningKey[] = [key],
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

function signedEnvelope(
  params: {
    keys?: readonly SigningKey[];
    feed?: unknown;
    payloadType?: string;
  } = {},
) {
  const payloadType = params.payloadType ?? PAYLOAD_TYPE;
  const payloadBytes = Buffer.from(JSON.stringify(params.feed ?? fixtureFeed()), "utf8");
  const payload = payloadBytes.toString("base64url");
  const input = signingInput(payloadType, payloadBytes);
  return {
    payloadType,
    payload,
    signatures: (params.keys ?? [key]).map((key) => ({
      keyid: key.keyId,
      sig: crypto.sign(null, input, key.privateKey).toString("base64url"),
    })),
  };
}

let key: SigningKey;
let envelope: ReturnType<typeof signedEnvelope>;
beforeEach(() => {
  key = createSigningKey("catalog-root");
  envelope = signedEnvelope();
});

it("enforces distinct trusted key material for signature thresholds", () => {
  const first = createSigningKey("first");
  const second = createSigningKey("second");
  expectVerification(
    signedEnvelope({ keys: [first, second] }),
    {
      ok: true,
      signedByKeyIds: ["first", "second"],
      signatureCount: 2,
      threshold: 2,
    },
    [first, second],
    { threshold: 2 },
  );
  const duplicate = { ...first, keyId: "duplicate-material" };
  expectVerification(
    signedEnvelope({ keys: [first, duplicate] }),
    "invalid-signature",
    [first, duplicate],
    { threshold: 2 },
  );
});

it("rejects payload bytes changed after signing", () => {
  envelope.payload = Buffer.from(
    JSON.stringify({ ...fixtureFeed(), sequence: 43 }),
    "utf8",
  ).toString("base64url");
  expectVerification(envelope, "invalid-signature");
});

it("distinguishes unknown keys from invalid trusted signatures", () => {
  const signer = createSigningKey("signer");
  const other = createSigningKey("other");
  const signed = signedEnvelope({ keys: [signer] });
  expectVerification(signed, "missing-trust-key", [other]);
  expectVerification(signed, "invalid-signature", [{ ...other, keyId: signer.keyId }]);
});

it("rejects duplicate key ids and excessive signature lists", () => {
  const signature = envelope.signatures[0];
  expectVerification({ ...envelope, signatures: [signature, signature] }, "invalid-envelope");
  expectVerification(
    {
      ...envelope,
      signatures: Array.from({ length: 17 }, (_, index) => ({
        ...signature,
        keyid: `key-${index}`,
      })),
    },
    "invalid-envelope",
  );
});

it("rejects unsupported payload types and signed invalid feeds", () => {
  expectVerification(signedEnvelope({ payloadType: "example.unsupported" }), "unsupported-payload");
  expectVerification(signedEnvelope({ feed: { entries: [] } }), {
    ok: false,
    error: "invalid-payload",
    authenticatedPayload: { entries: [] },
  });
});

it("rejects malformed envelopes before verification", () => {
  const signature = envelope.signatures[0];
  assert(signature);
  expectVerification(
    { payloadType: PAYLOAD_TYPE, payload: "", signatures: [] },
    "invalid-envelope",
    [],
  );
  expectVerification({ ...envelope, signatures: [{ sig: signature.sig }] }, "invalid-envelope");
});

it("accepts beta legacy field names only for persisted snapshots", () => {
  const signature = envelope.signatures[0];
  assert(signature);
  const legacySignature = {
    keyId: signature.keyid,
    algorithm: "ed25519",
    signature: signature.sig,
  };
  const legacyEnvelope = { ...envelope, schemaVersion: 1, signatures: [legacySignature] };
  expectVerification(legacyEnvelope, "invalid-envelope");
  expectVerification(legacyEnvelope, { ok: true, signedBy: key.keyId }, [key], {
    allowLegacyBetaEnvelope: true,
  });
  const mixedEnvelope = {
    ...envelope,
    schemaVersion: 1,
    signatures: [signature, legacySignature],
  };
  expectVerification(mixedEnvelope, "invalid-envelope");
  expectVerification(mixedEnvelope, "invalid-envelope", [key], { allowLegacyBetaEnvelope: true });
});
