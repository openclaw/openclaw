import { missingTargetError } from "../infra/outbound/target-errors.js";
import {
  areEquivalentWhatsAppDirectTargets,
  isWhatsAppGroupJid,
  normalizeWhatsAppTarget,
} from "./normalize.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";
  const allowListRaw = (params.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
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
    // Enforce allowFrom for all direct-message send modes (including explicit).
    // Group destinations are handled by group policy and are allowed above.
    if (hasWildcard || allowList.length === 0) {
      return { ok: true, to: normalizedTo };
    }
    const matchedAllowTarget = allowList.find(
      (entry) => entry === normalizedTo || areEquivalentWhatsAppDirectTargets(entry, normalizedTo),
    );
    if (matchedAllowTarget) {
      // Prefer the allowlist's canonical entry so outbound sends reuse the exact JID/E.164 form
      // that the operator previously authorized (important for BR contacts that surface without
      // the mobile ninth digit on WhatsApp).
      return { ok: true, to: matchedAllowTarget };
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
