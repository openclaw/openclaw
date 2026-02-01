/**
 * Security infrastructure types
 */

// =============================================================================
// Unlock & Session Types
// =============================================================================

export interface UnlockConfig {
  /** Whether unlock protection is enabled */
  enabled: boolean;
  /** bcrypt hash of unlock password */
  passwordHash?: string;
  /** How long unlock lasts in ms (default 24h) */
  sessionDurationMs: number;
}

export interface UnlockSession {
  /** Session ID */
  id: string;
  /** When the session was created */
  createdAt: number;
  /** When the session expires */
  expiresAt: number;
  /** Whether session is still valid */
  valid: boolean;
}

export type UnlockFailureReason =
  | "wrong_password"
  | "wrong_2fa"
  | "invalid_recovery_code"
  | "locked_out"
  | "session_expired";

export interface UnlockEvent {
  /** Event ID */
  id: string;
  /** Timestamp */
  ts: number;
  /** Whether unlock was successful */
  success: boolean;
  /** Failure reason if not successful */
  failureReason?: UnlockFailureReason;
  /** Client IP address */
  ipAddress?: string;
  /** User agent string */
  userAgent?: string;
  /** Device fingerprint for grouping */
  deviceFingerprint?: string;
}

// =============================================================================
// Two-Factor Authentication Types
// =============================================================================

export interface TwoFactorConfig {
  /** Whether 2FA is enabled */
  enabled: boolean;
  /** Encrypted TOTP secret */
  totpSecret?: string;
  /** Hashed recovery codes (8 codes) */
  backupCodes?: string[];
  /** When 2FA was enabled */
  enabledAt?: number;
}

export interface TwoFactorSetupData {
  /** Base32-encoded secret for manual entry */
  secret: string;
  /** otpauth:// URI for QR code */
  otpauthUrl: string;
  /** QR code as data URL */
  qrCodeDataUrl: string;
}

export interface RecoveryCodesData {
  /** Plain-text recovery codes (shown only once) */
  codes: string[];
  /** When codes were generated */
  generatedAt: number;
}

// =============================================================================
// Security State
// =============================================================================

export interface SecurityConfig {
  unlock: UnlockConfig;
  twoFactor: TwoFactorConfig;
}

export interface SecurityState {
  lockEnabled: boolean;
  isUnlocked: boolean;
  session: UnlockSession | null;
  twoFactorEnabled: boolean;
  requiresSetup: boolean;
}

// =============================================================================
// Storage Types
// =============================================================================

export interface SecurityStorageData {
  config: SecurityConfig;
  sessions: Map<string, UnlockSession>;
  history: UnlockEvent[];
  pendingSetup?: TwoFactorSetupData;
  failedAttempts: {
    count: number;
    lastAttempt: number;
    lockedUntil?: number;
  };
}

// =============================================================================
// Default Values
// =============================================================================

export const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_UNLOCK_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const RECOVERY_CODE_COUNT = 8;
export const RECOVERY_CODE_LENGTH = 8;
export const MAX_UNLOCK_HISTORY_ENTRIES = 100;

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  unlock: {
    enabled: false,
    sessionDurationMs: DEFAULT_SESSION_DURATION_MS,
  },
  twoFactor: {
    enabled: false,
  },
};
