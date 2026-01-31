import fs from "node:fs/promises";
import path from "node:path";
import { logError } from "../logger.js";

export interface AuditEvent {
  timestamp: string;
  eventType: string;
  userId?: string;
  action: string;
  resource: string;
  details?: Record<string, unknown>;
  success: boolean;
}

const LOG_DIR = process.env.LOG_DIR || "./logs";

export async function logAuditEvent(event: Omit<AuditEvent, "timestamp">): Promise<void> {
  const fullEvent: AuditEvent = { ...event, timestamp: new Date().toISOString() };
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, "audit.log");
    await fs.appendFile(logFile, JSON.stringify(fullEvent) + "\n", "utf8");
  } catch (error) {
    logError(`Failed to write audit log: ${String(error)}`);
  }
}

export async function logSecurityIncident(
  incidentType: string,
  details: Record<string, unknown>,
  userId?: string,
  ip?: string
): Promise<void> {
  const event = {
    timestamp: new Date().toISOString(),
    type: "SECURITY_INCIDENT",
    incidentType,
    userId,
    ip,
    details,
  };
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, "security.log");
    await fs.appendFile(logFile, JSON.stringify(event) + "\n", "utf8");
  } catch (error) {
    logError(`Failed to write security log: ${String(error)}`);
  }
}
