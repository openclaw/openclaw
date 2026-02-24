import { normalizeE164 } from "../utils.js";

/**
 * DDDs (area codes) that keep the 9th digit in WhatsApp format.
 * These are São Paulo (11-19), Rio de Janeiro (21, 22, 24), and Espírito Santo (27, 28).
 * For all other DDDs, the 9th digit must be removed.
 *
 * @see https://support.gupshup.io/hc/en-us/articles/4407840924953
 */
const BRAZIL_DDD_WITH_NINTH_DIGIT = new Set([
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19, // São Paulo
  21,
  22,
  24, // Rio de Janeiro
  27,
  28, // Espírito Santo
]);

/**
 * Normalize Brazilian phone numbers for WhatsApp.
 * Brazilian mobile numbers have two formats:
 * - Carrier format (14 digits): +55 DD 9XXXX XXXX
 * - WhatsApp internal format (13 digits): +55 DD XXXX XXXX
 *
 * WhatsApp internally registers numbers without the 9th digit for most area codes.
 * Only DDDs 11-19 (SP), 21-22, 24 (RJ), and 27-28 (ES) keep the 9th digit.
 *
 * @param phone - Phone number (should already have + prefix)
 * @returns Normalized phone number for WhatsApp
 */
export function normalizeBrazilPhone(phone: string): string {
  // Brazilian format: +55 (2 digits DDD) + 9 (optional) + 8 digits
  // Carrier format: +55DD9XXXXXXXX (14 digits total including +)
  // WhatsApp format: +55DDXXXXXXXX (13 digits total including +)
  if (!phone.startsWith("+55") || phone.length !== 14 || phone[5] !== "9") {
    return phone;
  }

  // Extract DDD (area code) - digits at positions 3 and 4 after +55
  const ddd = parseInt(phone.slice(3, 5), 10);

  // For DDDs that keep the 9th digit, return as-is
  if (BRAZIL_DDD_WITH_NINTH_DIGIT.has(ddd)) {
    return phone;
  }

  // For other DDDs, remove the 9th digit
  return phone.slice(0, 5) + phone.slice(6);
}

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
  // Apply Brazilian phone normalization before E.164
  const brazilNormalized = normalizeBrazilPhone(candidate);
  const normalized = normalizeE164(brazilNormalized);
  return normalized.length > 1 ? normalized : null;
}
