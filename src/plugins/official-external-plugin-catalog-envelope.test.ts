import assert from "node:assert/strict";
import { beforeEach, expect, it } from "vitest";
import {
  CATALOG_PAYLOAD_TYPE as PAYLOAD_TYPE,
  createSigningKey,
  signCatalogEnvelope,
  legacyCatalogEnvelope,
} from "./official-external-catalog-signing.test-support.js";
import { verifyOfficialExternalPluginCatalogSignedEnvelope } from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

type SigningKey = ReturnType<typeof createSigningKey>;

function fixtureFeed(): OfficialExternalPluginCatalogFeed {
  return {
    schemaVersion: 2,
    id: "clawhub-official",
    generatedAt: "2026-06-30T00:00:00.000Z",
    sequence: 42,
    entries: [],
  };
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

function signedEnvelope(
  params: {
    keys?: readonly SigningKey[];
    feed?: unknown;
    payloadType?: string;
  } = {},
) {
  return signCatalogEnvelope(
    params.feed ?? fixtureFeed(),
    params.keys ?? [key],
    params.payloadType,
  );
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
  const legacyEnvelope = legacyCatalogEnvelope(envelope);
  expectVerification(legacyEnvelope, "invalid-envelope");
  expectVerification(legacyEnvelope, { ok: true, signedBy: key.keyId }, [key], {
    allowLegacyBetaEnvelope: true,
  });
  const mixedEnvelope = {
    ...envelope,
    schemaVersion: 1,
    signatures: [signature, legacyEnvelope.signatures[0]],
  };
  expectVerification(mixedEnvelope, "invalid-envelope");
  expectVerification(mixedEnvelope, "invalid-envelope", [key], { allowLegacyBetaEnvelope: true });
});
