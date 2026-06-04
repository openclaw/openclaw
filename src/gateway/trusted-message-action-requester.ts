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
  requesterSourceProvider?: string;
  senderIsOwner: boolean;
}) {
  return Buffer.from(JSON.stringify({ v: 1, ...params }), "utf8").toString("base64url");
}

function readPayload(encodedPayload: string): {
  requesterSenderId: string | undefined;
  requesterSourceProvider: string | undefined;
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
    const requesterSourceProvider = normalizeOptionalLowercaseString(
      (decoded as { requesterSourceProvider?: unknown }).requesterSourceProvider as
        | string
        | undefined,
    );
    const senderIsOwner = (decoded as { senderIsOwner?: unknown }).senderIsOwner === true;
    return (requesterSenderId && requesterSourceProvider) || senderIsOwner
      ? { requesterSenderId, requesterSourceProvider, senderIsOwner }
      : null;
  } catch {
    return null;
  }
}

function resolveRequesterSourceProvider(params: {
  requesterSourceProvider?: string | null;
  currentChannelProvider?: string | null;
}): string | undefined {
  return (
    normalizeOptionalLowercaseString(params.requesterSourceProvider) ??
    normalizeOptionalLowercaseString(params.currentChannelProvider)
  );
}

export function createTrustedMessageActionRequesterToken(params: {
  requesterSenderId?: string | null;
  requesterSourceProvider?: string | null;
  currentChannelProvider?: string | null;
  senderIsOwner?: boolean;
}): string | undefined {
  const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
  const requesterSourceProvider = resolveRequesterSourceProvider(params);
  const senderIsOwner = params.senderIsOwner === true;
  if ((!requesterSenderId || !requesterSourceProvider) && !senderIsOwner) {
    return undefined;
  }
  const encodedPayload = encodePayload({
    ...(requesterSenderId && requesterSourceProvider
      ? { requesterSenderId, requesterSourceProvider }
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
  requesterSourceProvider?: string | null;
  currentChannelProvider?: string | null;
}): boolean {
  const payload = readVerifiedPayload(params.token);
  if (!payload) {
    return false;
  }
  return (
    payload.requesterSenderId === normalizeOptionalString(params.requesterSenderId) &&
    payload.requesterSourceProvider === resolveRequesterSourceProvider(params)
  );
}

export function verifyTrustedMessageActionOwnerToken(params: {
  token?: string | null;
  senderIsOwner?: boolean;
}): boolean {
  const payload = readVerifiedPayload(params.token);
  return Boolean(payload?.senderIsOwner === true && params.senderIsOwner === true);
}
