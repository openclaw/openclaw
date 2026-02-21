/**
 * Masked Secrets — Secret Store
 *
 * Loads, stores, and manages masked secrets. Secrets are loaded from:
 * 1. ~/.openclaw/.env (dotenv file)
 * 2. Process environment variables matching configured patterns
 * 3. Config file (openclaw.json secrets section)
 *
 * The store holds the real values but never exposes them to the agent.
 * Only the gateway/runtime can access real values for substitution.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveConfigDir } from "../../utils.js";
import type { MaskedSecret, MaskedSecretsConfig } from "./types.js";

const log = createSubsystemLogger("security/masked-secrets");

/**
 * Well-known env var patterns that typically contain secrets.
 * Used for auto-detection when config.mask is empty.
 */
const AUTO_DETECT_PATTERNS = [
  /^[A-Z_]*API[_]?KEY$/i,
  /^[A-Z_]*SECRET$/i,
  /^[A-Z_]*TOKEN$/i,
  /^[A-Z_]*PASSWORD$/i,
  /^[A-Z_]*CREDENTIALS?$/i,
  /^[A-Z_]*AUTH$/i,
  /^[A-Z_]*PRIVATE[_]?KEY$/i,
  // Common specific keys
  /^OPENAI_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^GITHUB_TOKEN$/,
  /^GITHUB_PAT$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^BRAVE_API_KEY$/,
  /^FIRECRAWL_API_KEY$/,
  /^ELEVENLABS_API_KEY$/,
];

export class SecretStore {
  private secrets: Map<string, MaskedSecret> = new Map();
  private config: MaskedSecretsConfig;

  constructor(config?: Partial<MaskedSecretsConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      mask: config?.mask ?? [],
      outputPatterns: config?.outputPatterns ?? [],
      blockedCommands: config?.blockedCommands ?? ["env", "printenv", "set", "export"],
      blockSecretFileReads: config?.blockSecretFileReads ?? true,
      secretFilePaths: config?.secretFilePaths ?? [
        ".env",
        "*.key",
        "*.pem",
        "credentials.json",
        "auth-profiles.json",
      ],
    };
  }

  /** Load secrets from all configured sources */
  load(): void {
    if (!this.config.enabled) {
      return;
    }

    this.loadFromDotEnv();
    this.loadFromProcessEnv();

    log.info(`Loaded ${this.secrets.size} masked secrets`);
  }

  /** Load secrets from ~/.openclaw/.env */
  private loadFromDotEnv(): void {
    const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
    if (!fs.existsSync(globalEnvPath)) {
      return;
    }

    const parsed = dotenv.parse(fs.readFileSync(globalEnvPath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (this.shouldMask(key)) {
        this.secrets.set(key, {
          name: key,
          value,
          source: "dotenv",
        });
      }
    }
  }

  /** Load secrets from process.env matching configured patterns */
  private loadFromProcessEnv(): void {
    for (const [key, value] of Object.entries(process.env)) {
      if (value && this.shouldMask(key) && !this.secrets.has(key)) {
        this.secrets.set(key, {
          name: key,
          value,
          source: "env",
        });
      }
    }
  }

  /**
   * Determine if an env var name should be masked.
   * Checks explicit config list first, then auto-detection patterns.
   */
  private shouldMask(name: string): boolean {
    // Check explicit mask list
    if (this.config.mask.length > 0) {
      return this.config.mask.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`, "i");
          return regex.test(name);
        }
        return pattern === name;
      });
    }

    // Auto-detect mode: check against known patterns
    return AUTO_DETECT_PATTERNS.some((pattern) => pattern.test(name));
  }

  /** Get a secret value by name (for substitution — never expose to agent) */
  resolve(name: string): string | undefined {
    return this.secrets.get(name)?.value;
  }

  /** Check if a name is a registered secret */
  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /** Get all secret names (but not values!) */
  listNames(): string[] {
    return Array.from(this.secrets.keys());
  }

  /** Get all secret values (for redaction matching) */
  getValues(): string[] {
    return Array.from(this.secrets.values())
      .map((s) => s.value)
      .filter((v) => v.length >= 8); // Don't redact very short values (too many false positives)
  }

  /** Get the full config */
  getConfig(): MaskedSecretsConfig {
    return this.config;
  }

  /** Update config at runtime */
  updateConfig(config: Partial<MaskedSecretsConfig>): void {
    Object.assign(this.config, config);
    this.secrets.clear();
    this.load();
  }
}
