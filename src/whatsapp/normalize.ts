import { normalizeE164 } from "../utils.js";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith("@g.us")) {
    return false;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return false;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

/**
 * Check if value looks like a WhatsApp user target (e.g. "41796666864:0@s.whatsapp.net" or "123@lid").
 */
export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}

/**
 * Extract the phone number from a WhatsApp user JID.
 * "41796666864:0@s.whatsapp.net" -> "41796666864"
 * "123456@lid" -> "123456"
 */
function extractUserJidPhone(jid: string): string | null {
  const userMatch = jid.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    return userMatch[1];
  }
  const lidMatch = jid.match(WHATSAPP_LID_RE);
  if (lidMatch) {
    return lidMatch[1];
  }
  return null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }
  // Handle user JIDs (e.g. "41796666864:0@s.whatsapp.net")
  if (isWhatsAppUserTarget(candidate)) {
    const phone = extractUserJidPhone(candidate);
    if (!phone) {
      return null;
    }
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }
  // If the caller passed a JID-ish string that we don't understand, fail fast.
  // Otherwise normalizeE164 would happily treat "group:120@g.us" as a phone number.
  if (candidate.includes("@")) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

/**
 * Expand direct-target variants that WhatsApp may surface differently from the human-facing phone.
 *
 * Brazil is the main footgun here: some chats/contacts resolve with the mobile ninth digit removed,
 * while humans/config entries often keep the full E.164 with the extra 9. Treat both forms as
 * equivalent for WhatsApp matching.
 */
export function expandWhatsAppDirectTargetVariants(value: string): string[] {
  const normalized = normalizeWhatsAppTarget(value);
  if (!normalized || isWhatsAppGroupJid(normalized)) {
    return normalized ? [normalized] : [];
  }
  const variants = new Set<string>([normalized]);
  const digits = normalized.replace(/\D/g, "");

  // BR mobile with ninth digit: +55 AA 9 XXXXXXXX -> +55 AA XXXXXXXX
  const withNinthDigit = digits.match(/^55(\d{2})9([6-9]\d{7})$/);
  if (withNinthDigit) {
    variants.add(`+55${withNinthDigit[1]}${withNinthDigit[2]}`);
  }

  // BR mobile without ninth digit: +55 AA XXXXXXXX -> +55 AA 9 XXXXXXXX
  const withoutNinthDigit = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  if (withoutNinthDigit) {
    variants.add(`+55${withoutNinthDigit[1]}9${withoutNinthDigit[2]}`);
  }

  return [...variants];
}

export function areEquivalentWhatsAppDirectTargets(a: string, b: string): boolean {
  const left = expandWhatsAppDirectTargetVariants(a);
  const right = new Set(expandWhatsAppDirectTargetVariants(b));
  return left.some((candidate) => right.has(candidate));
}
