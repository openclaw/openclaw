import crypto from "node:crypto";

/**
 * UPC (User Protocol Credential) Manager
 * Handles secure credential storage, hashing, and verification with rate limiting.
 */

interface UPCConfig {
  enabled: boolean;
  credentialHash?: string; // scrypt hash of the UPC
}

interface RateLimitEntry {
  attempts: number;
  lastAttemptMs: number;
  locked: boolean;
  lockedUntilMs?: number;
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes after 5 failed attempts
const VERIFICATION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

export class UPCManager {
  private config: UPCConfig = { enabled: false };
  private rateLimitBySessionId = new Map<string, RateLimitEntry>();
  private verifiedSessionIds = new Set<string>();
  private verifiedSessionExpiryMs = new Map<string, number>();
  private auditLog: Array<{
    timestamp: number;
    action: "set" | "verify_attempt" | "verify_success" | "verify_failure" | "locked";
    sessionId?: string;
    success?: boolean;
    remainingAttempts?: number;
  }> = [];

  constructor(config?: UPCConfig) {
    if (config) {
      this.config = { ...config };
    }
  }

  /**
   * Set or update the UPC credential
   * @param credential - The plaintext UPC code word/sequence
   * @throws Error if credential is empty or invalid
   */
  setUPC(credential: string): void {
    const trimmed = credential?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new Error("UPC credential cannot be empty");
    }
    if (trimmed.length < 4) {
      throw new Error("UPC credential must be at least 4 characters");
    }
    if (trimmed.length > 256) {
      throw new Error("UPC credential cannot exceed 256 characters");
    }

    this.config.credentialHash = this.hashCredential(trimmed);
    this.config.enabled = true;

    this.auditLog.push({
      timestamp: Date.now(),
      action: "set",
      success: true,
    });
  }

  /**
   * Disable UPC protection
   */
  disableUPC(): void {
    this.config.credentialHash = undefined;
    this.config.enabled = false;
    this.verifiedSessionIds.clear();
    this.verifiedSessionExpiryMs.clear();
  }

  /**
   * Check if UPC is enabled and has a credential set
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.credentialHash;
  }

  /**
   * Get UPC status (without exposing the credential)
   */
  getStatus(): {
    enabled: boolean;
    hasUPC: boolean;
    isLocked: boolean;
    remainingAttempts?: number;
  } {
    return {
      enabled: this.config.enabled,
      hasUPC: !!this.config.credentialHash,
      isLocked: false, // Can enhance to track global lockout if needed
    };
  }

  /**
   * Verify a UPC input against the stored credential
   * Includes rate limiting and session tracking
   */
  verifyUPC(
    input: string,
    sessionId: string,
  ): {
    verified: boolean;
    remainingAttempts?: number;
    error?: string;
  } {
    const now = Date.now();

    // Check if UPC is enabled
    if (!this.isEnabled()) {
      return {
        verified: false,
        error: "UPC is not enabled",
      };
    }

    // Check rate limiting for this session
    const rateLimitEntry = this.rateLimitBySessionId.get(sessionId) || {
      attempts: 0,
      lastAttemptMs: now,
      locked: false,
    };

    // Check if session is locked
    if (rateLimitEntry.locked && rateLimitEntry.lockedUntilMs! > now) {
      const remainingMs = rateLimitEntry.lockedUntilMs! - now;
      const remainingSec = Math.ceil(remainingMs / 1000);
      this.auditLog.push({
        timestamp: now,
        action: "locked",
        sessionId,
      });
      return {
        verified: false,
        error: `Too many failed attempts. Try again in ${remainingSec} seconds.`,
      };
    }

    // Reset lock if expired
    if (rateLimitEntry.locked && rateLimitEntry.lockedUntilMs! <= now) {
      rateLimitEntry.locked = false;
      rateLimitEntry.attempts = 0;
    }

    // Reset rate limit window if expired
    if (now - rateLimitEntry.lastAttemptMs > RATE_LIMIT_WINDOW_MS) {
      rateLimitEntry.attempts = 0;
    }

    // Check if max attempts exceeded in current window
    if (rateLimitEntry.attempts >= MAX_ATTEMPTS) {
      rateLimitEntry.locked = true;
      rateLimitEntry.lockedUntilMs = now + LOCKOUT_DURATION_MS;
      this.rateLimitBySessionId.set(sessionId, rateLimitEntry);
      this.auditLog.push({
        timestamp: now,
        action: "locked",
        sessionId,
      });
      return {
        verified: false,
        error: "Too many failed attempts. Please try again later.",
        remainingAttempts: 0,
      };
    }

    // Verify the credential
    const isValid = this.verifyCredential(input, this.config.credentialHash!);

    if (isValid) {
      // Mark session as verified
      this.verifiedSessionIds.add(sessionId);
      this.verifiedSessionExpiryMs.set(sessionId, now + VERIFICATION_EXPIRY_MS);

      // Reset rate limiting on success
      this.rateLimitBySessionId.delete(sessionId);

      this.auditLog.push({
        timestamp: now,
        action: "verify_success",
        sessionId,
      });

      return { verified: true };
    } else {
      // Increment failed attempts
      rateLimitEntry.attempts++;
      rateLimitEntry.lastAttemptMs = now;
      this.rateLimitBySessionId.set(sessionId, rateLimitEntry);

      const remainingAttempts = MAX_ATTEMPTS - rateLimitEntry.attempts;

      this.auditLog.push({
        timestamp: now,
        action: "verify_failure",
        sessionId,
        remainingAttempts,
      });

      return {
        verified: false,
        error: "Incorrect UPC. Please try again.",
        remainingAttempts,
      };
    }
  }

  /**
   * Check if a session is currently verified for UPC
   */
  isSessionVerified(sessionId: string): boolean {
    if (!this.isEnabled()) {
      return true; // No UPC protection, always "verified"
    }

    const verified = this.verifiedSessionIds.has(sessionId);
    if (!verified) {
      return false;
    }

    // Check expiration
    const expiryMs = this.verifiedSessionExpiryMs.get(sessionId);
    if (!expiryMs || expiryMs <= Date.now()) {
      this.verifiedSessionIds.delete(sessionId);
      this.verifiedSessionExpiryMs.delete(sessionId);
      return false;
    }

    return true;
  }

  /**
   * Mark a session as verified (e.g., after successful external verification)
   */
  markSessionVerified(sessionId: string, expiryMs?: number): void {
    this.verifiedSessionIds.add(sessionId);
    this.verifiedSessionExpiryMs.set(sessionId, expiryMs || Date.now() + VERIFICATION_EXPIRY_MS);
  }

  /**
   * Clear verification for a session
   */
  clearSessionVerification(sessionId: string): void {
    this.verifiedSessionIds.delete(sessionId);
    this.verifiedSessionExpiryMs.delete(sessionId);
    this.rateLimitBySessionId.delete(sessionId);
  }

  /**
   * Clear all cached verification and rate-limit state while keeping credential config.
   */
  clearAllVerifications(): void {
    this.verifiedSessionIds.clear();
    this.verifiedSessionExpiryMs.clear();
    this.rateLimitBySessionId.clear();
  }

  /**
   * Get audit log entries (last N entries)
   */
  getAuditLog(limit = 50): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Export configuration (credential hash only, never plaintext)
   */
  exportConfig(): UPCConfig {
    return { ...this.config };
  }

  /**
   * Import configuration
   */
  importConfig(config: UPCConfig): void {
    this.config = { ...config };
  }

  /**
   * Hash a credential using scrypt with per-credential random salt.
   */
  private hashCredential(credential: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(credential, salt, 64).toString("hex");
    return `scrypt$${salt}$${derived}`;
  }

  /**
   * Verify input against stored hash. Supports legacy SHA-256 hashes for compatibility.
   */
  private verifyCredential(input: string, storedHash: string): boolean {
    if (storedHash.startsWith("scrypt$")) {
      const [, salt, expectedHex] = storedHash.split("$");
      if (!salt || !expectedHex) {
        return false;
      }
      const actual = crypto.scryptSync(input, salt, 64);
      const expected = Buffer.from(expectedHex, "hex");
      return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
    }

    const legacyHash = crypto.createHash("sha256").update(input).digest("hex");
    const expected = Buffer.from(storedHash, "utf8");
    const actual = Buffer.from(legacyHash, "utf8");
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  }

  /**
   * Cleanup expired verifications
   */
  cleanupExpiredVerifications(): void {
    const now = Date.now();
    for (const [sessionId, expiryMs] of this.verifiedSessionExpiryMs.entries()) {
      if (expiryMs <= now) {
        this.verifiedSessionIds.delete(sessionId);
        this.verifiedSessionExpiryMs.delete(sessionId);
      }
    }

    // Also cleanup old audit log entries (keep last 1000)
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }
}

// Global instance for singleton access
let globalUPCManager: UPCManager | null = null;

export function getGlobalUPCManager(): UPCManager {
  if (!globalUPCManager) {
    globalUPCManager = new UPCManager();
  }
  return globalUPCManager;
}

export function setGlobalUPCManager(manager: UPCManager): void {
  globalUPCManager = manager;
}
