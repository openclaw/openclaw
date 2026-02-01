/**
 * Audit infrastructure exports
 */

// Types
export * from "./types.js";

// Event emitter
export {
  emitAuditEvent,
  onAuditEvent,
  getAuditListenerCount,
  clearAuditListeners,
} from "./audit-events.js";

// Log storage
export {
  resolveAuditDir,
  resolveCurrentAuditLogPath,
  appendAuditEvent,
  logAuditEvent,
  queryAuditEvents,
  cleanupOldAuditLogs,
  createConfigAuditEvent,
  createSecurityAuditEvent,
  createTokenAuditEvent,
  createAgentAuditEvent,
} from "./audit-log.js";

// Subscriber
export { startAuditSubscriber, stopAuditSubscriber } from "./audit-subscriber.js";
