import crypto from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function normalizeBase64(input: string): string {
  const trimmed = input.trim();
  const normalized = trimmed.replaceAll("-", "+").replaceAll("_", "/");
  return normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
}

function decodeBase64(input: string): Buffer {
  return Buffer.from(normalizeBase64(input), "base64");
}

function createEd25519PublicKey(publicKey: string): crypto.KeyObject {
  const trimmed = publicKey.trim();
  if (trimmed.includes("BEGIN")) {
    return crypto.createPublicKey(trimmed);
  }
  const decoded = decodeBase64(trimmed);
  if (decoded.length === 32) {
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, decoded]),
      type: "spki",
      format: "der",
    });
  }
  return crypto.createPublicKey({
    key: decoded,
    type: "spki",
    format: "der",
  });
}

function createEd25519PrivateKey(privateKey: string): crypto.KeyObject {
  const trimmed = privateKey.trim();
  if (trimmed.includes("BEGIN")) {
    return crypto.createPrivateKey(trimmed);
  }
  const decoded = decodeBase64(trimmed);
  if (decoded.length === 32) {
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, decoded]),
      type: "pkcs8",
      format: "der",
    });
  }
  if (decoded.length === 64) {
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, decoded.subarray(0, 32)]),
      type: "pkcs8",
      format: "der",
    });
  }
  return crypto.createPrivateKey({
    key: decoded,
    type: "pkcs8",
    format: "der",
  });
}

function toPayloadBuffer(payload: string | Buffer): Buffer {
  return typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
}

export function verifyEd25519Signature(params: {
  payload: string | Buffer;
  signatureBase64: string;
  publicKey: string;
}): boolean {
  try {
    const key = createEd25519PublicKey(params.publicKey);
    const signature = decodeBase64(params.signatureBase64);
    return crypto.verify(null, toPayloadBuffer(params.payload), key, signature);
  } catch {
    return false;
  }
}

export function signEd25519Payload(params: {
  payload: string | Buffer;
  privateKey: string;
}): string {
  const key = createEd25519PrivateKey(params.privateKey);
  const signature = crypto.sign(null, toPayloadBuffer(params.payload), key);
  return signature.toString("base64");
}
