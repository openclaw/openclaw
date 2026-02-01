/**
 * Audit event emitter
 *
 * Pub/sub pattern for audit events, similar to agent-events.ts.
 */

import type { AuditEvent, AuditEventBase } from "./types.js";

const listeners = new Set<(evt: AuditEvent) => void>();

/**
 * Emit an audit event to all listeners.
 */
export function emitAuditEvent(event: AuditEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * Subscribe to audit events.
 * Returns an unsubscribe function.
 */
export function onAuditEvent(listener: (evt: AuditEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Get the number of active listeners.
 */
export function getAuditListenerCount(): number {
  return listeners.size;
}

/**
 * Clear all listeners (for testing).
 */
export function clearAuditListeners(): void {
  listeners.clear();
}
