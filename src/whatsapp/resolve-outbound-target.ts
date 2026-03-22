import { missingTargetError } from "../infra/outbound/target-errors.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  /** When defined, used for outbound target gating instead of allowFrom.
   * Set to ["*"] to allow sending to any number while keeping allowFrom restricted for inbound. */
  allowTo?: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";
  // Use allowTo for outbound gating when explicitly configured; otherwise fall back to allowFrom.
  // Use != null (not !== undefined) to treat both null and undefined as "not set".
  const outboundListSource = params.allowTo != null ? params.allowTo : params.allowFrom;
  const outboundListRaw = (outboundListSource ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const hasWildcard = outboundListRaw.includes("*");
  const outboundList = outboundListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (trimmed) {
    const normalizedTo = normalizeWhatsAppTarget(trimmed);
    if (!normalizedTo) {
      return {
        ok: false,
        error: missingTargetError("WhatsApp", "<E.164|group JID>"),
      };
    }
    if (isWhatsAppGroupJid(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    // Enforce outbound allowlist for direct-message sends.
    // Group destinations are handled by group policy and are allowed above.
    if (hasWildcard || outboundList.length === 0) {
      return { ok: true, to: normalizedTo };
    }
    if (outboundList.includes(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID>"),
    };
  }

  return {
    ok: false,
    error: missingTargetError("WhatsApp", "<E.164|group JID>"),
  };
}
