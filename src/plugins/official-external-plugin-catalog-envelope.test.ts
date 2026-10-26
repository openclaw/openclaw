import assert from "node:assert/strict";
import { beforeEach, expect, it } from "vitest";
import {
  createSigningKey,
  signCatalogEnvelope,
  legacyCatalogEnvelope,
} from "./official-external-catalog-signing.test-support.js";
import { verifyOfficialExternalPluginCatalogSignedEnvelope } from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

type SigningKey = ReturnType<typeof createSigningKey>;

const feed: OfficialExternalPluginCatalogFeed = {
  schemaVersion: 2,
  id: "clawhub-official",
  generatedAt: "2026-06-30T00:00:00.000Z",
  sequence: 42,
  entries: [],
};

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

const sign = (keys = [key], body: unknown = feed, type?: string) =>
  signCatalogEnvelope(body, keys, type);

let key: SigningKey;
let envelope: ReturnType<typeof sign>;
beforeEach(() => {
  key = createSigningKey("catalog-root");
  envelope = sign();
});

it("enforces distinct trusted key material for signature thresholds", () => {
  const first = createSigningKey("first");
  const second = createSigningKey("second");
  expectVerification(
    sign([first, second]),
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
  expectVerification(sign([first, duplicate]), "invalid-signature", [first, duplicate], {
    threshold: 2,
  });
});

it("rejects payload bytes changed after signing", () => {
  envelope.payload = Buffer.from(JSON.stringify({ ...feed, sequence: 43 }), "utf8").toString(
    "base64url",
  );
  expectVerification(envelope, "invalid-signature");
});

it("distinguishes unknown keys from invalid trusted signatures", () => {
  const signer = createSigningKey("signer");
  const other = createSigningKey("other");
  const signed = sign([signer]);
  expectVerification(signed, "missing-trust-key", [other]);
  expectVerification(signed, "invalid-signature", [{ ...other, keyId: signer.keyId }]);
});

it.each([
  ["duplicate keys", () => [envelope.signatures[0], envelope.signatures[0]]],
  [
    "excess signatures",
    () => Array.from({ length: 17 }, (_, i) => ({ ...envelope.signatures[0], keyid: `key-${i}` })),
  ],
  ["missing key id", () => [{ sig: envelope.signatures[0]!.sig }]],
  ["empty signatures", () => []],
] as const)("rejects %s before verification", (_name, signatures) => {
  expectVerification({ ...envelope, signatures: signatures() }, "invalid-envelope");
});

it("rejects unsupported payload types and signed invalid feeds", () => {
  expectVerification(sign(undefined, feed, "example.unsupported"), "unsupported-payload");
  expectVerification(sign(undefined, { entries: [] }), {
    ok: false,
    error: "invalid-payload",
    authenticatedPayload: { entries: [] },
  });
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
