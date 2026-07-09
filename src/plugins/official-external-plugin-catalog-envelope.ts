import { verifyEd25519SignatureBytes } from "../infra/ed25519-signature.js";
import { isRecord } from "../utils.js";
import {
  isOfficialExternalPluginCatalogFeed,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE =
  "openclaw.official-external-plugin-catalog-feed.v1";
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES = 16;

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
  payloadBytes: Buffer;
}): Buffer {
  return dssePreAuthenticationEncoding(params.payloadType, params.payloadBytes);
}

export function verifyOfficialExternalPluginCatalogSignedEnvelope(
  raw: unknown,
  params: {
    trustedKeys: readonly OfficialExternalPluginCatalogTrustedSigningKey[];
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
  const payloadBytes = decodeOfficialExternalPluginCatalogEnvelopePayloadBytes(envelope.payload);
  if (!payloadBytes) {
    return {
      ok: false,
      error: "invalid-payload",
      message: "hosted catalog signed envelope payload is invalid",
    };
  }
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType: envelope.payloadType,
    payloadBytes,
  });
  let trustedSignatureKeyId: string | undefined;
  for (const envelopeSignature of envelope.signatures) {
    const keyId = envelopeSignature.keyId;
    const trustedKey = params.trustedKeys.find((candidate) => candidate.keyId === keyId);
    if (!trustedKey) {
      continue;
    }
    if (
      verifyEd25519SignatureBytes({
        publicKey: trustedKey.publicKey,
        payload: signingInput,
        signatureBase64Url: envelopeSignature.signature,
      })
    ) {
      trustedSignatureKeyId = trustedKey.keyId;
      break;
    }
  }
  if (trustedSignatureKeyId) {
    const feed = decodeOfficialExternalPluginCatalogEnvelopePayload(payloadBytes);
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
      signedBy: trustedSignatureKeyId,
    };
  }
  const hasKnownKey = envelope.signatures.some((signature) =>
    params.trustedKeys.some((key) => key.keyId === signature.keyId),
  );
  return hasKnownKey
    ? {
        ok: false,
        error: "invalid-signature",
        message: "hosted catalog signed envelope signature is invalid",
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
  if (signatures.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES) {
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
  if (parsedSignatures.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES) {
    return null;
  }
  const keyIds = new Set<string>();
  for (const signature of parsedSignatures) {
    if (keyIds.has(signature.keyId)) {
      return null;
    }
    keyIds.add(signature.keyId);
  }
  return {
    payloadType,
    payload,
    signatures: parsedSignatures,
  };
}

function dssePreAuthenticationEncoding(payloadType: string, payloadBytes: Buffer): Buffer {
  const payloadTypeBytes = Buffer.from(payloadType, "utf8");
  const prefix = Buffer.from(
    `DSSEv1 ${payloadTypeBytes.length} ${payloadType} ${payloadBytes.length} `,
    "utf8",
  );
  return Buffer.concat([prefix, payloadBytes]);
}

function decodeOfficialExternalPluginCatalogEnvelopePayloadBytes(payload: string): Buffer | null {
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function decodeOfficialExternalPluginCatalogEnvelopePayload(
  payloadBytes: Buffer,
): OfficialExternalPluginCatalogFeed | null {
  try {
    const raw = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    return isOfficialExternalPluginCatalogFeed(raw) ? raw : null;
  } catch {
    return null;
  }
}
