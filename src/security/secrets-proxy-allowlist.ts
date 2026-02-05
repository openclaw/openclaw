import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/secrets-proxy-allowlist");

export const DEFAULT_ALLOWED_DOMAINS = [
  // ==========================================
  // LLM Providers (from pi-ai)
  // ==========================================
  "api.anthropic.com",
  "api.openai.com",
  "auth.openai.com",
  // Google APIs (covers generativelanguage, cloudcode-pa, oauth2, ai.google.dev, etc.)
  "googleapis.com",
  "google.com", // accounts.google.com for OAuth
  "ai.google.dev",
  // OpenRouter
  "openrouter.ai",
  // Mistral
  "api.mistral.ai",
  // xAI / Grok
  "api.x.ai",
  "api.z.ai",
  // Cerebras
  "api.cerebras.ai",
  // Kimi / Moonshot
  "api.kimi.com",
  "api.moonshot.ai",
  // Minimax
  "api.minimax.chat",
  "api.minimax.io",
  "api.minimaxi.com",
  // Qwen
  "portal.qwen.ai",
  // Synthetic
  "api.synthetic.new",
  // Venice
  "api.venice.ai",
  // HuggingFace
  "router.huggingface.co",
  "huggingface.co",
  // Vercel AI Gateway
  "ai-gateway.vercel.sh",
  // GitHub Copilot
  "api.github.com",
  "api.individual.githubcopilot.com",
  // AWS Bedrock (common regions)
  "amazonaws.com",

  // ==========================================
  // Search / Web Tools
  // ==========================================
  "api.perplexity.ai",
  "api.search.brave.com",
  "api.firecrawl.dev",

  // ==========================================
  // Audio / TTS / Media
  // ==========================================
  "api.groq.com",
  "api.deepgram.com",
  "api.elevenlabs.io",

  // ==========================================
  // Messaging Channels
  // ==========================================
  "api.telegram.org",
  "discord.com",
  "api.pluralkit.me",
  // Slack
  "slack.com",
  "files.slack.com",
  "slack-edge.com",
  // Feishu / Lark
  "larksuite.com",
  "feishu.cn",
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
    // Reject URLs with userinfo to prevent data exfiltration via Basic Auth headers
    if (parsed.username || parsed.password) {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
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
