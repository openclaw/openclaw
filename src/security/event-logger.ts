import type { SecurityEvent } from "./events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { appendAuditEntry } from "./audit-log.js";

const securityLogger = createSubsystemLogger("security");

export function emitSecurityEvent(event: SecurityEvent): void {
  const { severity, eventType, ...meta } = event;
  const message = `[${eventType}] ${event.action}${event.detail ? `: ${event.detail}` : ""}`;

  // Route to appropriate log level based on severity
  if (severity === "critical") {
    securityLogger.error(message, meta);
  } else if (severity === "warn") {
    securityLogger.warn(message, meta);
  } else {
    securityLogger.info(message, meta);
  }

  appendAuditEntry(event);
}
