/**
 * Brazil WhatsApp JID Resolution
 *
 * Brazilian mobile numbers transitioned from 8 to 9 digits (adding leading '9')
 * around 2012-2016. WhatsApp accounts created before migration may still be
 * registered with the old 8-digit format internally.
 *
 * This resolver queries WhatsApp to find the correct registered JID format.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface JidCache {
  [inputJid: string]: { resolvedJid: string; ts: number };
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_PATH = join(homedir(), ".config", "moltbot", "brazil-jid-cache.json");

function loadCache(): JidCache {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch {
    // Ignore cache read errors
  }
  return {};
}

function saveCache(cache: JidCache): void {
  try {
    const dir = dirname(CACHE_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Check if a JID is a Brazilian mobile number that might need resolution
 */
function isBrazilianMobile(jid: string): boolean {
  const match = jid.match(/^(\d+)@s\.whatsapp\.net$/i);
  if (!match) return false;

  const digits = match[1];
  if (!digits.startsWith("55")) return false;

  // Brazil format: 55 + 2-digit area code + 8 or 9 digit local
  // Area codes are 11-99
  const areaCode = digits.slice(2, 4);
  const areaNum = parseInt(areaCode, 10);
  if (areaNum < 11 || areaNum > 99) return false;

  const localNumber = digits.slice(4);
  // Mobile numbers are 8 digits (legacy) or 9 digits (modern, starts with 9)
  return localNumber.length === 8 || (localNumber.length === 9 && localNumber.startsWith("9"));
}

/**
 * Generate both 8-digit and 9-digit variants of a Brazilian mobile JID
 */
function generateVariants(jid: string): string[] {
  const match = jid.match(/^(\d+)@s\.whatsapp\.net$/i);
  if (!match) return [jid];

  const digits = match[1];
  const areaCode = digits.slice(2, 4);
  const localNumber = digits.slice(4);

  const variants: string[] = [];

  if (localNumber.length === 9 && localNumber.startsWith("9")) {
    // Input is 9-digit format, generate 8-digit variant
    variants.push(`55${areaCode}${localNumber}@s.whatsapp.net`); // 9-digit
    variants.push(`55${areaCode}${localNumber.slice(1)}@s.whatsapp.net`); // 8-digit
  } else if (localNumber.length === 8) {
    // Input is 8-digit format, generate 9-digit variant
    variants.push(`55${areaCode}${localNumber}@s.whatsapp.net`); // 8-digit
    variants.push(`55${areaCode}9${localNumber}@s.whatsapp.net`); // 9-digit
  } else {
    variants.push(jid);
  }

  return variants;
}

export interface OnWhatsAppResult {
  exists: boolean;
  jid?: string;
}

export type OnWhatsAppFn = (jid: string) => Promise<OnWhatsAppResult[]>;

/**
 * Resolve a Brazilian WhatsApp JID to its correct registered format
 *
 * @param jid - The input JID (e.g., "5511999998888@s.whatsapp.net")
 * @param onWhatsApp - Baileys onWhatsApp function to query registration
 * @returns The resolved JID (may be different from input for Brazilian numbers)
 */
export async function resolveBrazilianJid(
  jid: string,
  onWhatsApp: OnWhatsAppFn,
): Promise<string> {
  // Only process Brazilian mobile numbers
  if (!isBrazilianMobile(jid)) {
    return jid;
  }

  // Check cache first
  const cache = loadCache();
  const cached = cache[jid];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.resolvedJid;
  }

  // Generate variants and query WhatsApp
  const variants = generateVariants(jid);

  for (const variant of variants) {
    try {
      const results = await onWhatsApp(variant);
      if (results?.[0]?.exists) {
        const resolvedJid = results[0].jid || variant;

        // Cache the result
        cache[jid] = { resolvedJid, ts: Date.now() };
        saveCache(cache);

        return resolvedJid;
      }
    } catch {
      // Continue to next variant on error
    }
  }

  // Fallback to original JID if no variant found
  return jid;
}
