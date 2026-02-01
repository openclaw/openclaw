/**
 * Audit log types
 */

export type AuditCategory = "config" | "agent" | "security" | "token";

export type AuditSeverity = "info" | "warn" | "error";

export type ConfigAuditAction = "config.get" | "config.patch" | "config.apply" | "config.set";

export type SecurityAuditAction =
  | "unlock.attempt"
  | "unlock.success"
  | "unlock.failure"
  | "unlock.lockout"
  | "password.setup"
  | "password.change"
  | "2fa.enable"
  | "2fa.disable"
  | "2fa.verify"
  | "2fa.recovery";

export type AgentAuditAction = "tool.execute" | "tool.approve" | "tool.reject" | "tool.error";

export type TokenAuditAction = "token.create" | "token.revoke" | "token.use";

export type AuditAction =
  | ConfigAuditAction
  | SecurityAuditAction
  | AgentAuditAction
  | TokenAuditAction;

export interface AuditEventBase {
  /** Event ID (UUIDv7) */
  id: string;
  /** Unix timestamp */
  ts: number;
  /** Event category */
  category: AuditCategory;
  /** Specific action */
  action: AuditAction;
  /** Severity level */
  severity: AuditSeverity;
  /** Actor ID (device/token/session) */
  actorId?: string;
}

export interface ConfigAuditEvent extends AuditEventBase {
  category: "config";
  action: ConfigAuditAction;
  detail: {
    path?: string;
    previousValue?: unknown;
    newValue?: unknown;
  };
}

export interface SecurityAuditEvent extends AuditEventBase {
  category: "security";
  action: SecurityAuditAction;
  detail: {
    method?: "password" | "2fa" | "recovery";
    ipAddress?: string;
    userAgent?: string;
    failureReason?: string;
  };
}

export interface AgentAuditEvent extends AuditEventBase {
  category: "agent";
  action: AgentAuditAction;
  detail: {
    runId: string;
    agentId?: string;
    toolName: string;
    toolCallId: string;
    phase: "start" | "end" | "error";
    input?: Record<string, unknown>;
    output?: unknown;
    durationMs?: number;
  };
}

export interface TokenAuditEvent extends AuditEventBase {
  category: "token";
  action: TokenAuditAction;
  detail: {
    tokenId: string;
    tokenName?: string;
    scopes?: string[];
  };
}

export type AuditEvent = ConfigAuditEvent | SecurityAuditEvent | AgentAuditEvent | TokenAuditEvent;

export interface AuditQueryParams {
  category?: AuditCategory;
  action?: AuditAction;
  severity?: AuditSeverity;
  startTs?: number;
  endTs?: number;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  total: number;
  hasMore: boolean;
}

export const AUDIT_LOG_RETENTION_DAYS = 90;
export const MAX_AUDIT_EVENTS_PER_QUERY = 1000;
