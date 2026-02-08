/**
 * Security Hardening Module for OpenClaw
 *
 * This module provides enhanced security defaults and automatic
 * remediation for common security misconfigurations.
 *
 * @module security/hardening
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding, SecurityAuditSeverity } from "./audit.js";

// ============================================================================
// Constants
// ============================================================================

/** Minimum recommended token length */
export const MIN_TOKEN_LENGTH = 32;

/** Recommended directory permissions (rwx------) */
export const SECURE_DIR_MODE = 0o700;

/** Recommended file permissions (rw-------) */
export const SECURE_FILE_MODE = 0o600;

/** Rate limit defaults */
export const RATE_LIMIT_DEFAULTS = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100,
  maxRequestsPerIp: 50,
} as const;

/** Dangerous patterns that should never appear in user input */
const DANGEROUS_INPUT_PATTERNS = [
  // Command injection
  /[;&|`$(){}[\]<>]/,
  // Path traversal
  /\.\.\//,
  /\.\.\\/, // Windows
  // Null bytes
  /\x00/,
  // Unicode direction overrides (potential for visual spoofing)
  /[\u202A-\u202E\u2066-\u2069]/,
] as const;

/** Environment variables that should never be exposed */
const SENSITIVE_ENV_VARS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_TOKEN",
  "SLACK_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "SESSION_SECRET",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
]);

// ============================================================================
// Types
// ============================================================================

export type HardeningAction = {
  id: string;
  description: string;
  severity: SecurityAuditSeverity;
  apply: () => Promise<void> | void;
  dryRun?: () => string;
};

export type HardeningResult = {
  applied: string[];
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
};

export type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
  maxRequestsPerIp: number;
};

export type InputValidationResult = {
  valid: boolean;
  sanitized: string;
  warnings: string[];
};

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generate a cryptographically secure token
 * @param length - Token length in bytes (will be hex encoded, so output is 2x length)
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString("hex");
}

/**
 * Generate a secure API key with prefix
 * @param prefix - Key prefix (e.g., "oc_live", "oc_test")
 */
export function generateApiKey(prefix: string = "oc"): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(24).toString("base64url");
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Validate token strength
 */
export function validateTokenStrength(token: string): {
  valid: boolean;
  score: number;
  issues: string[];
} {
  const issues: string[] = [];
  let score = 0;

  if (token.length >= MIN_TOKEN_LENGTH) {
    score += 25;
  } else {
    issues.push(`Token too short: ${token.length} < ${MIN_TOKEN_LENGTH}`);
  }

  if (/[a-z]/.test(token)) score += 15;
  if (/[A-Z]/.test(token)) score += 15;
  if (/[0-9]/.test(token)) score += 15;
  if (/[^a-zA-Z0-9]/.test(token)) score += 15;

  // Check for common weak patterns
  if (/^(.)\1+$/.test(token)) {
    issues.push("Token contains repeated characters");
    score -= 20;
  }
  if (/^(012|123|234|345|456|567|678|789|abc|xyz)/i.test(token)) {
    issues.push("Token starts with sequential characters");
    score -= 10;
  }

  // Entropy estimation
  const uniqueChars = new Set(token).size;
  const entropyRatio = uniqueChars / token.length;
  if (entropyRatio < 0.5) {
    issues.push("Token has low character diversity");
    score -= 15;
  } else {
    score += 15;
  }

  return {
    valid: score >= 70 && issues.length === 0,
    score: Math.max(0, Math.min(100, score)),
    issues,
  };
}

// ============================================================================
// Input Validation & Sanitization
// ============================================================================

/**
 * Validate and sanitize user input
 */
export function validateInput(
  input: string,
  options: {
    maxLength?: number;
    allowNewlines?: boolean;
    allowUnicode?: boolean;
  } = {}
): InputValidationResult {
  const { maxLength = 10000, allowNewlines = true, allowUnicode = true } = options;
  const warnings: string[] = [];
  let sanitized = input;

  // Length check
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
    warnings.push(`Input truncated to ${maxLength} characters`);
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_INPUT_PATTERNS) {
    if (pattern.test(sanitized)) {
      warnings.push(`Potentially dangerous pattern detected: ${pattern.source}`);
    }
  }

  // Remove null bytes
  if (sanitized.includes("\x00")) {
    sanitized = sanitized.replace(/\x00/g, "");
    warnings.push("Null bytes removed from input");
  }

  // Handle newlines
  if (!allowNewlines) {
    sanitized = sanitized.replace(/[\r\n]/g, " ");
  }

  // Handle non-ASCII if not allowed
  if (!allowUnicode) {
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[^\x00-\x7F]/g, "");
    if (sanitized !== input) {
      warnings.push("Non-ASCII characters removed");
    }
  }

  return {
    valid: warnings.length === 0,
    sanitized,
    warnings,
  };
}

/**
 * Sanitize file path to prevent traversal attacks
 */
export function sanitizePath(inputPath: string, baseDir: string): string | null {
  const path = require("node:path");

  // Normalize and resolve
  const resolved = path.resolve(baseDir, inputPath);
  const normalizedBase = path.resolve(baseDir);

  // Ensure path stays within base directory
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    return null;
  }

  return resolved;
}

// ============================================================================
// File Permission Hardening
// ============================================================================

/**
 * Ensure directory has secure permissions
 */
export function ensureSecureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  } else {
    const stats = fs.statSync(dirPath);
    if ((stats.mode & 0o777) !== SECURE_DIR_MODE) {
      fs.chmodSync(dirPath, SECURE_DIR_MODE);
    }
  }
}

/**
 * Ensure file has secure permissions
 */
export function ensureSecureFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    if ((stats.mode & 0o777) !== SECURE_FILE_MODE) {
      fs.chmodSync(filePath, SECURE_FILE_MODE);
    }
  }
}

/**
 * Check if path is a symlink (potential security risk)
 */
export function isSymlink(targetPath: string): boolean {
  try {
    const stats = fs.lstatSync(targetPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// ============================================================================
// Configuration Hardening
// ============================================================================

/**
 * Apply security hardening to configuration
 */
export function hardenConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  const hardened = structuredClone(config);

  // Ensure gateway auth exists when not on loopback
  if (hardened.gateway?.bind !== "loopback" && !hardened.gateway?.auth?.token) {
    if (!hardened.gateway) hardened.gateway = {};
    if (!hardened.gateway.auth) hardened.gateway.auth = {};
    hardened.gateway.auth.token = generateSecureToken();
    changes.push("Generated secure gateway auth token");
  }

  // Ensure logging redaction is enabled
  if (hardened.logging?.redactSensitive === "off") {
    hardened.logging.redactSensitive = "on";
    changes.push("Enabled sensitive data redaction in logs");
  }

  // Disable dangerous browser features by default
  if (hardened.browser?.evaluateEnabled === true) {
    hardened.browser.evaluateEnabled = false;
    changes.push("Disabled browser evaluate endpoint");
  }

  // Ensure control UI has proper auth
  if (hardened.gateway?.controlUi?.allowInsecureAuth === true) {
    hardened.gateway.controlUi.allowInsecureAuth = false;
    changes.push("Disabled insecure control UI auth");
  }

  if (hardened.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    hardened.gateway.controlUi.dangerouslyDisableDeviceAuth = false;
    changes.push("Re-enabled device auth for control UI");
  }

  return { config: hardened, changes };
}

/**
 * Generate security findings from config analysis
 */
export function analyzeConfigSecurity(config: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  // Check for exposed secrets in config
  const configStr = JSON.stringify(config);
  for (const envVar of SENSITIVE_ENV_VARS) {
    const pattern = new RegExp(`\\$\\{?${envVar}\\}?`, "g");
    if (!pattern.test(configStr)) {
      // Check if actual value might be hardcoded
      const valuePattern = new RegExp(`(api[_-]?key|token|secret|password).*?["']([^"']{20,})["']`, "gi");
      const matches = configStr.match(valuePattern);
      if (matches && matches.length > 0) {
        findings.push({
          checkId: "config.hardcoded_secrets",
          severity: "critical",
          title: "Potential hardcoded secrets detected",
          detail: "Config may contain hardcoded API keys or tokens. Use environment variables instead.",
          remediation: `Replace hardcoded values with environment variable references like \${${envVar}}`,
        });
        break;
      }
    }
  }

  return findings;
}

// ============================================================================
// Rate Limiting
// ============================================================================

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

/**
 * Simple in-memory rate limiter
 */
export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...RATE_LIMIT_DEFAULTS, ...config };
  }

  /**
   * Check if request should be allowed
   * @returns true if allowed, false if rate limited
   */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      this.store.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return true;
    }

    if (entry.count >= this.config.maxRequestsPerIp) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Get remaining requests for a key
   */
  remaining(key: string): number {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      return this.config.maxRequestsPerIp;
    }
    return Math.max(0, this.config.maxRequestsPerIp - entry.count);
  }

  /**
   * Clear expired entries (call periodically)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) {
        this.store.delete(key);
      }
    }
  }
}

// ============================================================================
// Secure Headers
// ============================================================================

/**
 * Get recommended security headers for HTTP responses
 */
export function getSecurityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  };
}

// ============================================================================
// Audit Log
// ============================================================================

export type AuditLogEntry = {
  timestamp: string;
  action: string;
  actor: string;
  resource: string;
  outcome: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

/**
 * Create an audit log entry
 */
export function createAuditLogEntry(
  action: string,
  actor: string,
  resource: string,
  outcome: AuditLogEntry["outcome"],
  details?: Record<string, unknown>
): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    action,
    actor,
    resource,
    outcome,
    details,
  };
}

// ============================================================================
// Export hardening actions
// ============================================================================

export function getHardeningActions(config: OpenClawConfig, stateDir: string): HardeningAction[] {
  const actions: HardeningAction[] = [];

  // 1. Secure state directory permissions
  actions.push({
    id: "secure_state_dir",
    description: "Set secure permissions on state directory",
    severity: "warn",
    apply: () => ensureSecureDirectory(stateDir),
    dryRun: () => `chmod 700 ${stateDir}`,
  });

  // 2. Generate gateway token if missing
  if (config.gateway?.bind !== "loopback" && !config.gateway?.auth?.token) {
    actions.push({
      id: "generate_gateway_token",
      description: "Generate secure gateway authentication token",
      severity: "critical",
      apply: () => {
        // This would need config file write access
        console.log(`Suggested token: ${generateSecureToken()}`);
      },
      dryRun: () => "Generate 64-character hex token for gateway.auth.token",
    });
  }

  // 3. Enable log redaction
  if (config.logging?.redactSensitive === "off") {
    actions.push({
      id: "enable_log_redaction",
      description: "Enable sensitive data redaction in logs",
      severity: "warn",
      apply: () => {
        console.log("Set logging.redactSensitive to 'on' in config");
      },
      dryRun: () => "Set logging.redactSensitive='on'",
    });
  }

  return actions;
}
