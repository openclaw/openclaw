/**
 * Security configuration storage
 *
 * Manages security config separate from main clawdbrain.json.
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashPassword, verifyPassword } from "./password.js";
import {
  generateTotpSetupData,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./totp.js";
import {
  recordUnlockAttempt,
  getUnlockHistory,
  createSuccessEvent,
  createFailureEvent,
  resolveUnlockHistoryPath,
} from "./unlock-history.js";
import type {
  SecurityConfig,
  SecurityState,
  UnlockSession,
  UnlockFailureReason,
  TwoFactorSetupData,
  RecoveryCodesData,
} from "./types.js";
import {
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_SESSION_DURATION_MS,
  MAX_UNLOCK_ATTEMPTS,
  LOCKOUT_DURATION_MS,
} from "./types.js";

/** Directory for security data */
const SECURITY_DIR = ".clawdbrain/security";

/** Security config file name */
const SECURITY_CONFIG_FILE = "security.json";

// In-memory state
let activeSessions = new Map<string, UnlockSession>();
let failedAttempts = { count: 0, lastAttempt: 0, lockedUntil: 0 };
let pendingTotpSetup: TwoFactorSetupData | null = null;

/**
 * Resolve the security config file path.
 */
export function resolveSecurityConfigPath(homeDir: string): string {
  return join(homeDir, SECURITY_DIR, SECURITY_CONFIG_FILE);
}

/**
 * Load security config from file.
 */
export async function loadSecurityConfig(configPath: string): Promise<SecurityConfig> {
  try {
    const content = await readFile(configPath, "utf-8");
    const data = JSON.parse(content);
    return {
      ...DEFAULT_SECURITY_CONFIG,
      ...data,
      unlock: { ...DEFAULT_SECURITY_CONFIG.unlock, ...data?.unlock },
      twoFactor: { ...DEFAULT_SECURITY_CONFIG.twoFactor, ...data?.twoFactor },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_SECURITY_CONFIG };
    }
    console.error("Failed to load security config:", error);
    return { ...DEFAULT_SECURITY_CONFIG };
  }
}

/**
 * Save security config to file.
 */
export async function saveSecurityConfig(
  configPath: string,
  config: SecurityConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get current security state.
 */
export async function getSecurityState(homeDir: string): Promise<SecurityState> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  // Find valid session
  let validSession: UnlockSession | null = null;
  const now = Date.now();

  for (const [, session] of activeSessions) {
    if (session.expiresAt > now && session.valid) {
      validSession = session;
      break;
    }
  }

  // Clean up expired sessions
  for (const [id, session] of activeSessions) {
    if (session.expiresAt <= now) {
      activeSessions.delete(id);
    }
  }

  return {
    lockEnabled: config.unlock.enabled,
    isUnlocked: !config.unlock.enabled || validSession !== null,
    session: validSession,
    twoFactorEnabled: config.twoFactor.enabled,
    requiresSetup: !config.unlock.enabled && !config.unlock.passwordHash,
  };
}

/**
 * Set up password protection.
 */
export async function setupPassword(
  homeDir: string,
  password: string,
): Promise<{ success: boolean; session?: UnlockSession }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  // Hash the password
  const passwordHash = await hashPassword(password);

  // Update config
  config.unlock = {
    ...config.unlock,
    enabled: true,
    passwordHash,
  };

  await saveSecurityConfig(configPath, config);

  // Create initial session
  const session = createSession(config.unlock.sessionDurationMs);

  return { success: true, session };
}

/**
 * Change password.
 */
export async function changePassword(
  homeDir: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  if (!config.unlock.passwordHash) {
    return { success: false };
  }

  // Verify current password
  const isValid = await verifyPassword(currentPassword, config.unlock.passwordHash);
  if (!isValid) {
    return { success: false };
  }

  // Hash new password
  const passwordHash = await hashPassword(newPassword);

  config.unlock.passwordHash = passwordHash;
  await saveSecurityConfig(configPath, config);

  return { success: true };
}

/**
 * Attempt to unlock.
 */
export async function unlock(
  homeDir: string,
  password: string,
  totpCode?: string,
  recoveryCode?: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{
  success: boolean;
  session?: UnlockSession;
  requires2fa?: boolean;
  failureReason?: UnlockFailureReason;
  attemptsRemaining?: number;
}> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const historyPath = resolveUnlockHistoryPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  // Check lockout
  if (failedAttempts.lockedUntil && failedAttempts.lockedUntil > Date.now()) {
    await recordUnlockAttempt(historyPath, createFailureEvent("locked_out", ipAddress, userAgent));
    return {
      success: false,
      failureReason: "locked_out",
      attemptsRemaining: 0,
    };
  }

  // Verify password
  if (!config.unlock.passwordHash) {
    return { success: false, failureReason: "wrong_password" };
  }

  const passwordValid = await verifyPassword(password, config.unlock.passwordHash);
  if (!passwordValid) {
    await recordUnlockAttempt(
      historyPath,
      createFailureEvent("wrong_password", ipAddress, userAgent),
    );
    return handleFailedAttempt("wrong_password");
  }

  // Check if 2FA is required
  if (config.twoFactor.enabled) {
    if (!totpCode && !recoveryCode) {
      return { success: false, requires2fa: true };
    }

    // Verify TOTP code
    if (totpCode && config.twoFactor.totpSecret) {
      const totpValid = verifyTotpCode(config.twoFactor.totpSecret, totpCode);
      if (!totpValid) {
        await recordUnlockAttempt(
          historyPath,
          createFailureEvent("wrong_2fa", ipAddress, userAgent),
        );
        return handleFailedAttempt("wrong_2fa");
      }
    }

    // Verify recovery code
    if (recoveryCode && config.twoFactor.backupCodes) {
      const codeIndex = verifyRecoveryCode(recoveryCode, config.twoFactor.backupCodes);
      if (codeIndex === -1) {
        await recordUnlockAttempt(
          historyPath,
          createFailureEvent("invalid_recovery_code", ipAddress, userAgent),
        );
        return handleFailedAttempt("invalid_recovery_code");
      }

      // Remove used recovery code
      config.twoFactor.backupCodes.splice(codeIndex, 1);
      await saveSecurityConfig(configPath, config);
    }
  }

  // Success - create session
  resetFailedAttempts();
  const session = createSession(config.unlock.sessionDurationMs);
  await recordUnlockAttempt(historyPath, createSuccessEvent(ipAddress, userAgent));

  return { success: true, session };
}

/**
 * Lock (invalidate current session).
 */
export function lockApp(): { success: boolean } {
  activeSessions.clear();
  return { success: true };
}

/**
 * Disable password protection.
 */
export async function disableLock(
  homeDir: string,
  password: string,
): Promise<{ success: boolean }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  if (!config.unlock.passwordHash) {
    return { success: false };
  }

  const isValid = await verifyPassword(password, config.unlock.passwordHash);
  if (!isValid) {
    return { success: false };
  }

  // Disable lock and 2FA
  config.unlock = {
    ...config.unlock,
    enabled: false,
    passwordHash: undefined,
  };
  config.twoFactor = {
    enabled: false,
  };

  await saveSecurityConfig(configPath, config);
  activeSessions.clear();

  return { success: true };
}

/**
 * Start 2FA setup.
 */
export async function setup2fa(
  homeDir: string,
  password: string,
): Promise<{ success: boolean; setupData?: TwoFactorSetupData }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  if (!config.unlock.passwordHash) {
    return { success: false };
  }

  const isValid = await verifyPassword(password, config.unlock.passwordHash);
  if (!isValid) {
    return { success: false };
  }

  // Generate setup data
  const setupData = await generateTotpSetupData();
  pendingTotpSetup = setupData;

  return { success: true, setupData };
}

/**
 * Verify 2FA setup with a code.
 */
export async function verify2fa(
  homeDir: string,
  code: string,
): Promise<{ success: boolean; recoveryCodes?: RecoveryCodesData }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  if (!pendingTotpSetup) {
    return { success: false };
  }

  // Verify the code
  const isValid = verifyTotpCode(pendingTotpSetup.secret, code);
  if (!isValid) {
    return { success: false };
  }

  // Generate recovery codes
  const recoveryCodesData = generateRecoveryCodes();
  const hashedCodes = recoveryCodesData.codes.map(hashRecoveryCode);

  // Enable 2FA
  config.twoFactor = {
    enabled: true,
    totpSecret: pendingTotpSetup.secret,
    backupCodes: hashedCodes,
    enabledAt: Date.now(),
  };

  await saveSecurityConfig(configPath, config);
  pendingTotpSetup = null;

  return { success: true, recoveryCodes: recoveryCodesData };
}

/**
 * Disable 2FA.
 */
export async function disable2fa(
  homeDir: string,
  password: string,
  code: string,
): Promise<{ success: boolean }> {
  const configPath = resolveSecurityConfigPath(homeDir);
  const config = await loadSecurityConfig(configPath);

  if (!config.unlock.passwordHash || !config.twoFactor.totpSecret) {
    return { success: false };
  }

  const passwordValid = await verifyPassword(password, config.unlock.passwordHash);
  if (!passwordValid) {
    return { success: false };
  }

  const codeValid = verifyTotpCode(config.twoFactor.totpSecret, code);
  if (!codeValid) {
    return { success: false };
  }

  // Disable 2FA
  config.twoFactor = {
    enabled: false,
  };

  await saveSecurityConfig(configPath, config);

  return { success: true };
}

/**
 * Get unlock history.
 */
export async function getSecurityHistory(
  homeDir: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ events: import("./types.js").UnlockEvent[]; total: number }> {
  const historyPath = resolveUnlockHistoryPath(homeDir);
  return getUnlockHistory(historyPath, options);
}

// =============================================================================
// Helper Functions
// =============================================================================

function createSession(durationMs: number = DEFAULT_SESSION_DURATION_MS): UnlockSession {
  const now = Date.now();
  const session: UnlockSession = {
    id: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + durationMs,
    valid: true,
  };

  activeSessions.set(session.id, session);
  return session;
}

function handleFailedAttempt(reason: UnlockFailureReason): {
  success: boolean;
  failureReason: UnlockFailureReason;
  attemptsRemaining: number;
} {
  failedAttempts.count++;
  failedAttempts.lastAttempt = Date.now();

  const attemptsRemaining = Math.max(0, MAX_UNLOCK_ATTEMPTS - failedAttempts.count);

  if (failedAttempts.count >= MAX_UNLOCK_ATTEMPTS) {
    failedAttempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }

  return {
    success: false,
    failureReason: reason,
    attemptsRemaining,
  };
}

function resetFailedAttempts(): void {
  failedAttempts = { count: 0, lastAttempt: 0, lockedUntil: 0 };
}

// For testing
export function resetSecurityState(): void {
  activeSessions.clear();
  resetFailedAttempts();
  pendingTotpSetup = null;
}
