/**
 * Security infrastructure exports
 */

// Types
export * from "./types.js";

// Password utilities
export { hashPassword, verifyPassword, isScryptHash } from "./password.js";

// TOTP utilities
export {
  generateTotpSecret,
  generateTotpSetupData,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./totp.js";

// Unlock history
export {
  resolveUnlockHistoryPath,
  loadUnlockHistory,
  saveUnlockHistory,
  recordUnlockAttempt,
  getUnlockHistory,
  createSuccessEvent,
  createFailureEvent,
} from "./unlock-history.js";

// Security store
export {
  resolveSecurityConfigPath,
  loadSecurityConfig,
  saveSecurityConfig,
  getSecurityState,
  setupPassword,
  changePassword,
  unlock,
  lockApp,
  disableLock,
  setup2fa,
  verify2fa,
  disable2fa,
  getSecurityHistory,
  resetSecurityState,
} from "./security-store.js";
