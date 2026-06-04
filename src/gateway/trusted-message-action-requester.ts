import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { safeEqualSecret } from "../security/secret-equal.js";

const TRUSTED_REQUESTER_TOKEN_PREFIX = "req1";
const trustedRequesterSecret = crypto.randomBytes(32).toString("hex");

function signPayload(encodedPayload: string): string {
  return crypto
    .createHmac("sha256", trustedRequesterSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function encodePayload(params: {
  requesterSenderId?: string;
  currentChannelProvider?: string;
  senderIsOwner: boolean;
}) {
  return Buffer.from(JSON.stringify({ v: 1, ...params }), "utf8").toString("base64url");
}

function readPayload(encodedPayload: string): {
  requesterSenderId: string | undefined;
  currentChannelProvider: string | undefined;
  senderIsOwner: boolean;
} | null {
  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || (decoded as { v?: unknown }).v !== 1) {
      return null;
    }
    const requesterSenderId = normalizeOptionalString(
      (decoded as { requesterSenderId?: unknown }).requesterSenderId as string | undefined,
    );
    const currentChannelProvider = normalizeOptionalLowercaseString(
      (decoded as { currentChannelProvider?: unknown }).currentChannelProvider as
        | string
        | undefined,
    );
    const senderIsOwner = (decoded as { senderIsOwner?: unknown }).senderIsOwner === true;
    return (requesterSenderId && currentChannelProvider) || senderIsOwner
      ? { requesterSenderId, currentChannelProvider, senderIsOwner }
      : null;
  } catch {
    return null;
  }
}

export function createTrustedMessageActionRequesterToken(params: {
  requesterSenderId?: string | null;
  currentChannelProvider?: string | null;
  senderIsOwner?: boolean;
}): string | undefined {
  const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
  const currentChannelProvider = normalizeOptionalLowercaseString(params.currentChannelProvider);
  const senderIsOwner = params.senderIsOwner === true;
  if ((!requesterSenderId || !currentChannelProvider) && !senderIsOwner) {
    return undefined;
  }
  const encodedPayload = encodePayload({
    ...(requesterSenderId && currentChannelProvider
      ? { requesterSenderId, currentChannelProvider }
      : {}),
    senderIsOwner,
  });
  return [TRUSTED_REQUESTER_TOKEN_PREFIX, encodedPayload, signPayload(encodedPayload)].join(".");
}

function readVerifiedPayload(token?: string | null): ReturnType<typeof readPayload> {
  const [prefix, encodedPayload, signature, extra] = normalizeOptionalString(token)?.split(".") ?? [
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  if (
    prefix !== TRUSTED_REQUESTER_TOKEN_PREFIX ||
    !encodedPayload ||
    !signature ||
    extra !== undefined ||
    !safeEqualSecret(signature, signPayload(encodedPayload))
  ) {
    return null;
  }
  return readPayload(encodedPayload);
}

export function verifyTrustedMessageActionRequesterToken(params: {
  token?: string | null;
  requesterSenderId?: string | null;
  currentChannelProvider?: string | null;
}): boolean {
  const payload = readVerifiedPayload(params.token);
  if (!payload) {
    return false;
  }
  return (
    payload.requesterSenderId === normalizeOptionalString(params.requesterSenderId) &&
    payload.currentChannelProvider ===
      normalizeOptionalLowercaseString(params.currentChannelProvider)
  );
}

export function verifyTrustedMessageActionOwnerToken(params: {
  token?: string | null;
  senderIsOwner?: boolean;
}): boolean {
  const payload = readVerifiedPayload(params.token);
  return Boolean(payload?.senderIsOwner === true && params.senderIsOwner === true);
}
