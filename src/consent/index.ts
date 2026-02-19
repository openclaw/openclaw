/**
 * ConsentGate: consent-gated authorization for high-risk tool execution.
 * See docs/grants/enterprise-consentgate-implementation-plan.md.
 */

export type { ConsentGateApi } from "./api.js";
export { createNoOpConsentGateApi } from "./api.js";
export { buildConsentDenyPayload } from "./deny-payload.js";
export type { ConsentEngineDeps } from "./engine.js";
export { createConsentEngine } from "./engine.js";
export { CONSENT_REASON, CONSENT_REASON_CODES } from "./reason-codes.js";
export type { ConsentReasonCode } from "./reason-codes.js";
export type { TokenStore } from "./store.js";
export { buildToken, createInMemoryTokenStore } from "./store.js";
export type {
  ConsentConsumeInput,
  ConsentConsumeResult,
  ConsentDenyPayload,
  ConsentIssueInput,
  ConsentRevokeInput,
  ConsentStatusQuery,
  ConsentStatusSnapshot,
  ConsentToken,
  ConsentTokenStatus,
  WalEvent,
  WalEventType,
} from "./types.js";
export type { WalWriter } from "./wal.js";
export { createInMemoryWal, createNoOpWal } from "./wal.js";
