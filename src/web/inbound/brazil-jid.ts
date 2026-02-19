/**
 * Brazil WhatsApp JID Resolver
 *
 * Handles the legacy 8-digit vs 9-digit mobile number issue in Brazil.
 * Uses Baileys' onWhatsApp() to discover the correct registered JID.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.CLAWDBOT_CONFIG_DIR || join(homedir(), ".config", "clawdbot");
const CACHE_FILE = join(CONFIG_DIR, "brazil-jid-cache.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  jid: string;
  originalInput: string;
  variant: string;
  timestamp: number;
}

interface JidCache {
  entries: Record<string, CacheEntry>;
  updatedAt: string;
}

// In-memory cache (persisted to disk)
let jidCache: Record<string, CacheEntry> | null = null;

function loadCache(): Record<string, CacheEntry> {
  if (jidCache !== null) return jidCache;

  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as JidCache;
      jidCache = data.entries || {};
    } else {
      jidCache = {};
    }
  } catch {
    jidCache = {};
  }
  return jidCache;
}

function saveCache(): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        {
          entries: jidCache,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[brazil-jid] Failed to save cache:", (err as Error).message);
  }
}

/**
 * Check if a number is a Brazilian mobile number that needs resolution
 */
export function isBrazilianMobile(digits: string): boolean {
  if (!digits.startsWith("55")) return false;

  const afterCountryCode = digits.slice(2);
  if (afterCountryCode.length < 10 || afterCountryCode.length > 11) return false;

  const areaCode = afterCountryCode.slice(0, 2);
  const areaNum = parseInt(areaCode, 10);
  if (areaNum < 11 || areaNum > 99) return false;

  const localNumber = afterCountryCode.slice(2);

  // Mobile numbers: 8-digit legacy or 9-digit modern (starts with 9)
  if (localNumber.length >= 8 && localNumber.length <= 9) {
    if (localNumber.length === 9 && localNumber[0] === "9") return true;
    if (localNumber.length === 8 && ["6", "7", "8", "9"].includes(localNumber[0])) return true;
  }

  return false;
}

/**
 * Generate both 8-digit and 9-digit variants for a Brazilian number
 */
export function generateBrazilianVariants(digits: string): string[] {
  if (!digits.startsWith("55")) return [digits];

  const areaCode = digits.slice(2, 4);
  const localNumber = digits.slice(4);

  const variants: string[] = [];

  if (localNumber.length === 9 && localNumber.startsWith("9")) {
    // Has 9-digit format: try as-is and without leading 9
    variants.push(digits); // 9-digit
    variants.push(`55${areaCode}${localNumber.slice(1)}`); // 8-digit
  } else if (localNumber.length === 8) {
    // Has 8-digit format: try as-is and with leading 9
    variants.push(digits); // 8-digit
    variants.push(`55${areaCode}9${localNumber}`); // 9-digit
  } else {
    variants.push(digits);
  }

  return variants;
}

interface OnWhatsAppResult {
  exists: boolean;
  jid?: string;
}

interface SockWithOnWhatsApp {
  onWhatsApp?: (jid: string) => Promise<OnWhatsAppResult[] | undefined>;
}

/**
 * Resolve a Brazilian WhatsApp JID to its correct registered format
 */
export async function resolveBrazilianJid(
  sock: SockWithOnWhatsApp,
  inputJid: string,
): Promise<string> {
  // Extract digits from JID
  const match = inputJid.match(/^(\d+)@/);
  if (!match) return inputJid;

  const digits = match[1];

  // Only process Brazilian mobile numbers
  if (!isBrazilianMobile(digits)) {
    return inputJid;
  }

  // Check cache first
  const cache = loadCache();
  const cached = cache[digits];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[brazil-jid] Cache hit: ${digits} → ${cached.jid}`);
    return cached.jid;
  }

  // Need onWhatsApp to resolve
  if (!sock.onWhatsApp) {
    return inputJid;
  }

  // Generate variants and query WhatsApp
  const variants = generateBrazilianVariants(digits);
  console.log(`[brazil-jid] Checking variants for ${digits}:`, variants);

  for (const variant of variants) {
    try {
      const results = await sock.onWhatsApp(variant);
      if (results?.[0]?.exists && results[0].jid) {
        const resolvedJid = results[0].jid;
        console.log(`[brazil-jid] Found: ${digits} → ${resolvedJid}`);

        // Cache the result
        cache[digits] = {
          jid: resolvedJid,
          originalInput: digits,
          variant,
          timestamp: Date.now(),
        };
        jidCache = cache;
        saveCache();

        return resolvedJid;
      }
    } catch {
      // Continue to next variant
    }
  }

  // Fallback to original
  return inputJid;
}
