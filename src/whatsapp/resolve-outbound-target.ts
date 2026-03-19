import { missingTargetError } from "../infra/outbound/target-errors.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  allowSendTo?: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";

  // When allowSendTo is explicitly defined, use it for outbound checks.
  // Otherwise fall back to allowFrom (legacy behavior).
  const hasExplicitSendTo = params.allowSendTo !== undefined && params.allowSendTo !== null;
  const outboundListRaw = (hasExplicitSendTo ? params.allowSendTo! : (params.allowFrom ?? []))
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
    // Group JIDs bypass allowFrom/allowSendTo intentionally: group sends are
    // governed by the separate groupPolicy/groupAllowFrom axis, not by the
    // per-DM allowlist.  This matches legacy allowFrom behavior and keeps
    // allowSendTo semantically consistent as a DM-only outbound gate.
    if (isWhatsAppGroupJid(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    // When allowSendTo is explicitly set, empty means "block all".
    // Legacy allowFrom behavior: empty means "allow all" (no restrictions).
    if (hasWildcard || (!hasExplicitSendTo && outboundList.length === 0)) {
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
