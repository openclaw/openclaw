import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
  createOfficialExternalPluginCatalogEnvelopePayload,
  createOfficialExternalPluginCatalogEnvelopeSigningInput,
  verifyOfficialExternalPluginCatalogSignedEnvelope,
  type OfficialExternalPluginCatalogSignedEnvelope,
} from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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

function exportRawPublicKeyBase64Url(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    Buffer.isBuffer(spki) &&
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url");
  }
  throw new Error("Expected Ed25519 SPKI public key");
}

function signedEnvelope(params?: {
  feed?: OfficialExternalPluginCatalogFeed;
  payload?: string;
  payloadType?: string;
  keyId?: string;
  privateKeyPem?: string;
}): {
  envelope: OfficialExternalPluginCatalogSignedEnvelope;
  publicKeyPem: string;
  rawPublicKey: string;
} {
  const { publicKey, privateKey } =
    params?.privateKeyPem === undefined
      ? crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
      : {
          publicKey: crypto
            .createPublicKey(crypto.createPrivateKey(params.privateKeyPem))
            .export({ type: "spki", format: "pem" }) as string,
          privateKey: params.privateKeyPem,
        };
  const payloadType = params?.payloadType ?? OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE;
  const payload =
    params?.payload ??
    createOfficialExternalPluginCatalogEnvelopePayload(params?.feed ?? fixtureFeed());
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType,
    payload,
  });
  const signature = crypto
    .sign(null, Buffer.from(signingInput, "utf8"), crypto.createPrivateKey(privateKey))
    .toString("base64url");
  return {
    envelope: {
      schemaVersion: 1,
      payloadType,
      payload,
      signatures: [
        {
          keyId: params?.keyId ?? "clawhub-root-2026",
          algorithm: "ed25519",
          signature,
        },
      ],
    },
    publicKeyPem: publicKey,
    rawPublicKey: exportRawPublicKeyBase64Url(publicKey),
  };
}

describe("official external plugin catalog signed envelopes", () => {
  it("verifies a signed ClawHub feed envelope with a trusted PEM key", () => {
    const { envelope, publicKeyPem } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toEqual({
      ok: true,
      signedBy: "clawhub-root-2026",
      feed: fixtureFeed(),
    });
  });

  it("verifies a signed ClawHub feed envelope with a trusted raw base64url key", () => {
    const { envelope, rawPublicKey } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: rawPublicKey }],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects payload bytes changed after signing", () => {
    const { envelope, publicKeyPem } = signedEnvelope();
    const tamperedFeed = { ...fixtureFeed(), sequence: 43 };
    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        payload: createOfficialExternalPluginCatalogEnvelopePayload(tamperedFeed),
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("rejects signatures made by an untrusted key id", () => {
    const { envelope, publicKeyPem } = signedEnvelope({ keyId: "unknown-key" });

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "missing-trust-key",
    });
  });

  it("rejects signatures made by the wrong trusted key", () => {
    const { envelope } = signedEnvelope();
    const { publicKeyPem: wrongPublicKey } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: wrongPublicKey }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("rejects unsupported payload types before trusting the payload", () => {
    const { envelope, publicKeyPem } = signedEnvelope({
      payloadType: "openclaw.other-feed.v1",
    });

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "unsupported-payload",
    });
  });

  it("rejects malformed envelopes and invalid feed payloads", () => {
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { schemaVersion: 1, payloadType: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE },
        { trustedKeys: [] },
      ),
    ).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });

    const malformedPayload = signedEnvelope({
      payload: Buffer.from(JSON.stringify({ schemaVersion: 99 }), "utf8").toString("base64url"),
    });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(malformedPayload.envelope, {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: malformedPayload.publicKeyPem }],
      }),
    ).toMatchObject({
      ok: false,
      error: "invalid-payload",
    });
  });
});
