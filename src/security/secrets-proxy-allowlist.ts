import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/secrets-proxy-allowlist");

export const DEFAULT_PROXY_PORT = 8080;

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

/**
 * Unified secrets proxy config stored at STATE_DIR/secrets-proxy-config.json.
 * Extensible for future proxy settings.
 */
export type SecretsProxyConfig = {
  port?: number;
  domains: string[];
};

const CONFIG_PATH = path.join(STATE_DIR, "secrets-proxy-config.json");
/** @deprecated Legacy path — migrated automatically on first load. */
const LEGACY_ALLOWLIST_PATH = path.join(STATE_DIR, "allowlist.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadConfig(): SecretsProxyConfig {
  // Migrate legacy allowlist.json → secrets-proxy-config.json on first access
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_ALLOWLIST_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_ALLOWLIST_PATH, "utf8");
      const legacy = JSON.parse(raw) as { domains?: string[] };
      const migrated: SecretsProxyConfig = {
        domains: Array.isArray(legacy.domains) ? legacy.domains : [],
      };
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(migrated, null, 2), "utf8");
      fs.unlinkSync(LEGACY_ALLOWLIST_PATH);
      logger.info("Migrated legacy allowlist.json → secrets-proxy-config.json");
    } catch (err) {
      logger.error(`Failed to migrate legacy allowlist: ${String(err)}`);
    }
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    return { domains: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as SecretsProxyConfig;
  } catch (err) {
    logger.error(`Failed to read secrets proxy config at ${CONFIG_PATH}: ${String(err)}`);
    return { domains: [] };
  }
}

function saveConfig(config: SecretsProxyConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    logger.error(`Failed to save secrets proxy config to ${CONFIG_PATH}: ${String(err)}`);
    throw err;
  }
}

function getUserDomains(): string[] {
  return loadConfig().domains ?? [];
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export function loadProxyPort(): number {
  const port = loadConfig().port;
  return typeof port === "number" && Number.isFinite(port) && port > 0 ? port : DEFAULT_PROXY_PORT;
}

export function setProxyPort(port: number): void {
  const config = loadConfig();
  config.port = port;
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Allowlist (public API unchanged)
// ---------------------------------------------------------------------------

export function loadAllowlist(): string[] {
  const domains = new Set(DEFAULT_ALLOWED_DOMAINS);
  const config = loadConfig();

  if (Array.isArray(config.domains)) {
    for (const domain of config.domains) {
      if (typeof domain === "string" && domain.trim()) {
        domains.add(domain.trim().toLowerCase());
      }
    }
  }

  return Array.from(domains).toSorted();
}

export function saveAllowlist(userDomains: string[]): void {
  const config = loadConfig();
  config.domains = userDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  saveConfig(config);
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
  const normalized = domain.trim().toLowerCase();

  // We only save user domains to the file, not the defaults
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
