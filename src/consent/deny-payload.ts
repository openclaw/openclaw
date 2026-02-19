import { getConsentReasonMessage } from "./reason-codes.js";
import type { ConsentDenyPayload } from "./types.js";

type BuildConsentDenyPayloadInput = {
  reasonCode: string;
  correlationId: string;
  tool: string;
  sessionKey: string;
  trustTier: string;
  jti?: string | null;
};

/**
 * Build a stable deny payload used across HTTP and WS responses.
 * This keeps runbooks and client-side triage consistent.
 */
export function buildConsentDenyPayload(input: BuildConsentDenyPayloadInput): ConsentDenyPayload {
  return {
    reasonCode: input.reasonCode,
    message: getConsentReasonMessage(input.reasonCode),
    correlationId: input.correlationId,
    tool: input.tool,
    sessionKey: input.sessionKey,
    trustTier: input.trustTier,
    jti: input.jti ?? null,
  };
}
