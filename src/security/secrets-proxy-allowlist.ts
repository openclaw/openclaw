import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/secrets-proxy-allowlist");

export const DEFAULT_ALLOWED_DOMAINS = [
  // Core LLM providers
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.openrouter.ai",

  // Search / Perplexity
  "api.perplexity.ai",

  // Audio transcription
  "api.groq.com",

  // Alternative providers
  "api.minimax.chat",
  "api.minimax.io",
  "api.moonshot.ai",
  "portal.qwen.ai",
  "api.synthetic.new",
  "api.venice.ai",
];

const ALLOWLIST_PATH = path.join(STATE_DIR, "allowlist.json");

export type AllowlistData = {
  domains: string[];
};

export function loadAllowlist(): string[] {
  const domains = new Set(DEFAULT_ALLOWED_DOMAINS);

  if (fs.existsSync(ALLOWLIST_PATH)) {
    try {
      const raw = fs.readFileSync(ALLOWLIST_PATH, "utf8");
      const data = JSON.parse(raw) as AllowlistData;
      if (Array.isArray(data.domains)) {
        for (const domain of data.domains) {
          if (typeof domain === "string" && domain.trim()) {
            domains.add(domain.trim().toLowerCase());
          }
        }
      }
    } catch (err) {
      logger.error(`Failed to read allowlist at ${ALLOWLIST_PATH}: ${String(err)}`);
    }
  }

  return Array.from(domains).sort();
}

export function saveAllowlist(userDomains: string[]): void {
  try {
    const data: AllowlistData = {
      domains: userDomains.map((d) => d.trim().toLowerCase()).filter(Boolean),
    };
    fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    logger.error(`Failed to save allowlist to ${ALLOWLIST_PATH}: ${String(err)}`);
    throw err;
  }
}

export function isDomainAllowed(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

export function addToAllowlist(domain: string): void {
  const current = loadAllowlist();
  const normalized = domain.trim().toLowerCase();
  
  // We only save user domains to the file, not the defaults
  // So we need to figure out which ones are user domains
  const userDomains = getUserDomains();
  if (!userDomains.includes(normalized) && !DEFAULT_ALLOWED_DOMAINS.includes(normalized)) {
    userDomains.push(normalized);
    saveAllowlist(userDomains);
  }
}

export function removeFromAllowlist(domain: string): void {
  const normalized = domain.trim().toLowerCase();
  const userDomains = getUserDomains();
  const filtered = userDomains.filter((d) => d !== normalized);
  if (filtered.length !== userDomains.length) {
    saveAllowlist(filtered);
  } else if (DEFAULT_ALLOWED_DOMAINS.includes(normalized)) {
    logger.warn(`Cannot remove default domain from allowlist: ${domain}`);
    throw new Error(`Cannot remove default domain: ${domain}`);
  }
}

function getUserDomains(): string[] {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    const data = JSON.parse(raw) as AllowlistData;
    return Array.isArray(data.domains) ? data.domains : [];
  } catch {
    return [];
  }
}
