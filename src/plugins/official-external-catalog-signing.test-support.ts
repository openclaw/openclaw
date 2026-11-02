import crypto from "node:crypto";

const CATALOG_PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

export function createSigningKey(keyId: string, privateKeyPem?: string) {
  const privateKey = privateKeyPem
    ? crypto.createPrivateKey(privateKeyPem)
    : crypto.generateKeyPairSync("ed25519").privateKey;
  const publicKey = crypto.createPublicKey(privateKey);
  return { keyId, privateKey, publicKey };
}

export function signCatalogEnvelope(
  feed: unknown,
  keys: readonly ReturnType<typeof createSigningKey>[],
  payloadType = CATALOG_PAYLOAD_TYPE,
) {
  const bytes = Buffer.from(JSON.stringify(feed), "utf8");
  const input = Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${bytes.length} `, "utf8"),
    bytes,
  ]);
  return {
    payloadType,
    payload: bytes.toString("base64url"),
    signatures: keys.map(({ keyId, privateKey }) => ({
      keyid: keyId,
      sig: crypto.sign(null, input, privateKey).toString("base64url"),
    })),
  };
}

export function legacyCatalogEnvelope(envelope: ReturnType<typeof signCatalogEnvelope>) {
  return {
    ...envelope,
    schemaVersion: 1,
    signatures: envelope.signatures.map(({ keyid, sig }) => ({
      keyId: keyid,
      algorithm: "ed25519",
      signature: sig,
    })),
  };
}
