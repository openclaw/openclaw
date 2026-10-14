import { createHmac, randomBytes } from "node:crypto";
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { safeEqualSecret } from "../security/secret-equal.js";

const MANAGED_OUTGOING_IMAGE_TICKET_SCOPE = "managed-outgoing-image";
export const MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS = 5 * 60 * 1000;
const managedOutgoingImageTicketSecret = randomBytes(32);

type ManagedOutgoingImageTicketPayload = {
  scope: typeof MANAGED_OUTGOING_IMAGE_TICKET_SCOPE;
  sessionKey: string;
  attachmentId: string;
  variant: "full";
  exp: number;
};

function signManagedOutgoingImageTicketPayload(encodedPayload: string): string {
  return createHmac("sha256", managedOutgoingImageTicketSecret)
    .update(encodedPayload)
    .digest("base64url");
}

export function createManagedOutgoingImageTicket(params: {
  sessionKey: string;
  attachmentId: string;
  nowMs?: number;
}): { ticket: string; expiresAt: string } | null {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const exp = asDateTimestampMs(now + MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS);
  if (exp === undefined) {
    return null;
  }
  const payload: ManagedOutgoingImageTicketPayload = {
    scope: MANAGED_OUTGOING_IMAGE_TICKET_SCOPE,
    sessionKey: params.sessionKey,
    attachmentId: params.attachmentId,
    variant: "full",
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signManagedOutgoingImageTicketPayload(encodedPayload);
  return {
    ticket: `v1.${encodedPayload}.${signature}`,
    expiresAt: resolveTimestampMsToIsoString(exp),
  };
}

export function verifyManagedOutgoingImageTicket(params: {
  ticket: string | null;
  sessionKey: string;
  attachmentId: string;
  nowMs?: number;
}): boolean {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return false;
  }
  const parts = params.ticket?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return false;
  }
  const [, encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return false;
  }
  if (!safeEqualSecret(signature, signManagedOutgoingImageTicketPayload(encodedPayload))) {
    return false;
  }
  try {
    const payload = asOptionalRecord(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    return (
      payload?.scope === MANAGED_OUTGOING_IMAGE_TICKET_SCOPE &&
      payload.sessionKey === params.sessionKey &&
      payload.attachmentId === params.attachmentId &&
      payload.variant === "full" &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp) &&
      payload.exp >= now
    );
  } catch {
    return false;
  }
}
