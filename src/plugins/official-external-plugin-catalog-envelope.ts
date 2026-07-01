import {
  normalizeEd25519PublicKeyBase64Url,
  verifyEd25519Signature,
} from "../infra/ed25519-signature.js";
import { isRecord } from "../utils.js";
import {
  isOfficialExternalPluginCatalogFeed,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE =
  "openclaw.official-external-plugin-catalog-feed.v1";
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENVELOPE_SIGNING_CONTEXT = "openclaw.feed-envelope.v1";

export type OfficialExternalPluginCatalogEnvelopeSignature = {
  keyId?: string;
  algorithm?: string;
  signature?: string;
};

export type OfficialExternalPluginCatalogSignedEnvelope = {
  schemaVersion?: number;
  payloadType?: string;
  payload?: string;
  signatures?: readonly OfficialExternalPluginCatalogEnvelopeSignature[];
};

export type OfficialExternalPluginCatalogTrustedSigningKey = {
  keyId: string;
  publicKey: string;
};

export type OfficialExternalPluginCatalogEnvelopeVerificationResult =
  | {
      ok: true;
      feed: OfficialExternalPluginCatalogFeed;
      signedBy: string;
      signedByKeyIds?: readonly string[];
      signatureCount?: number;
      threshold?: number;
    }
  | {
      ok: false;
      error:
        | "invalid-envelope"
        | "unsupported-payload"
        | "invalid-payload"
        | "missing-trust-key"
        | "invalid-signature";
      message: string;
    };

export function createOfficialExternalPluginCatalogEnvelopePayload(
  feed: OfficialExternalPluginCatalogFeed,
): string {
  return Buffer.from(JSON.stringify(feed), "utf8").toString("base64url");
}

export function createOfficialExternalPluginCatalogEnvelopeSigningInput(params: {
  payloadType: string;
  payload: string;
}): string {
  return [
    OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENVELOPE_SIGNING_CONTEXT,
    params.payloadType,
    params.payload,
  ].join(".");
}

export function verifyOfficialExternalPluginCatalogSignedEnvelope(
  raw: unknown,
  params: {
    trustedKeys: readonly OfficialExternalPluginCatalogTrustedSigningKey[];
    threshold?: number;
  },
): OfficialExternalPluginCatalogEnvelopeVerificationResult {
  const envelope = parseOfficialExternalPluginCatalogSignedEnvelope(raw);
  if (!envelope) {
    return {
      ok: false,
      error: "invalid-envelope",
      message: "hosted catalog signed envelope is malformed",
    };
  }
  if (envelope.payloadType !== OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE) {
    return {
      ok: false,
      error: "unsupported-payload",
      message: "hosted catalog signed envelope payload type is unsupported",
    };
  }
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType: envelope.payloadType,
    payload: envelope.payload,
  });
  const threshold = Math.max(1, Math.trunc(params.threshold ?? 1));
  const trustedSignatureKeyIds: string[] = [];
  const trustedSignaturePublicKeys = new Set<string>();
  for (const envelopeSignature of envelope.signatures) {
    const keyId = envelopeSignature.keyId;
    const trustedKey = params.trustedKeys.find((candidate) => candidate.keyId === keyId);
    if (!trustedKey || trustedSignatureKeyIds.includes(trustedKey.keyId)) {
      continue;
    }
    const normalizedPublicKey = normalizeEd25519PublicKeyBase64Url(trustedKey.publicKey);
    if (!normalizedPublicKey || trustedSignaturePublicKeys.has(normalizedPublicKey)) {
      continue;
    }
    if (
      verifyEd25519Signature({
        publicKey: trustedKey.publicKey,
        payload: signingInput,
        signatureBase64Url: envelopeSignature.signature,
      })
    ) {
      trustedSignatureKeyIds.push(trustedKey.keyId);
      trustedSignaturePublicKeys.add(normalizedPublicKey);
      if (trustedSignaturePublicKeys.size >= threshold) {
        break;
      }
    }
  }
  if (trustedSignaturePublicKeys.size >= threshold) {
    const feed = decodeOfficialExternalPluginCatalogEnvelopePayload(envelope.payload);
    if (!feed) {
      return {
        ok: false,
        error: "invalid-payload",
        message: "hosted catalog signed envelope payload is invalid",
      };
    }
    return {
      ok: true,
      feed,
      signedBy: trustedSignatureKeyIds[0] ?? "",
      ...(threshold > 1
        ? {
            signedByKeyIds: trustedSignatureKeyIds,
            signatureCount: trustedSignaturePublicKeys.size,
            threshold,
          }
        : {}),
    };
  }
  const hasKnownKey = envelope.signatures.some((signature) =>
    params.trustedKeys.some((key) => key.keyId === signature.keyId),
  );
  return hasKnownKey
    ? {
        ok: false,
        error: "invalid-signature",
        message:
          trustedSignatureKeyIds.length > 0
            ? "hosted catalog signed envelope did not meet the configured signature threshold"
            : "hosted catalog signed envelope signature is invalid",
      }
    : {
        ok: false,
        error: "missing-trust-key",
        message: "hosted catalog signed envelope was not signed by a trusted key",
      };
}

function parseOfficialExternalPluginCatalogSignedEnvelope(raw: unknown): {
  payloadType: string;
  payload: string;
  signatures: readonly Required<OfficialExternalPluginCatalogEnvelopeSignature>[];
} | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    return null;
  }
  const payloadType = raw.payloadType;
  const payload = raw.payload;
  const signatures = raw.signatures;
  if (typeof payloadType !== "string" || typeof payload !== "string") {
    return null;
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return null;
  }
  const parsedSignatures = signatures.filter(
    (signature): signature is Required<OfficialExternalPluginCatalogEnvelopeSignature> =>
      isRecord(signature) &&
      typeof signature.keyId === "string" &&
      signature.keyId.trim().length > 0 &&
      signature.algorithm === "ed25519" &&
      typeof signature.signature === "string" &&
      signature.signature.trim().length > 0,
  );
  if (parsedSignatures.length === 0) {
    return null;
  }
  return {
    payloadType,
    payload,
    signatures: parsedSignatures,
  };
}

function decodeOfficialExternalPluginCatalogEnvelopePayload(
  payload: string,
): OfficialExternalPluginCatalogFeed | null {
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const raw = JSON.parse(decoded) as unknown;
    return isOfficialExternalPluginCatalogFeed(raw) ? raw : null;
  } catch {
    return null;
  }
}
