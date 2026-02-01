/**
 * Audit subscriber for agent events
 *
 * Subscribes to agent events and transforms them into audit events.
 */

import { onAgentEvent, type AgentEventPayload } from "../agent-events.js";
import { logAuditEvent, createAgentAuditEvent } from "./audit-log.js";
import type { AuditSeverity } from "./types.js";

let unsubscribe: (() => void) | null = null;
let homeDir: string | null = null;

/**
 * Start subscribing to agent events for audit logging.
 */
export function startAuditSubscriber(homeDirPath: string): void {
  if (unsubscribe) {
    // Already subscribed
    return;
  }

  homeDir = homeDirPath;

  unsubscribe = onAgentEvent(async (event: AgentEventPayload) => {
    // Only log tool events
    if (event.stream !== "tool") {
      return;
    }

    if (!homeDir) {
      return;
    }

    try {
      const data = event.data as {
        name?: string;
        callId?: string;
        phase?: string;
        input?: Record<string, unknown>;
        output?: unknown;
        error?: unknown;
        durationMs?: number;
      };

      // Determine action and severity
      let action: "tool.execute" | "tool.approve" | "tool.reject" | "tool.error";
      let severity: AuditSeverity = "info";

      if (data.phase === "error" || data.error) {
        action = "tool.error";
        severity = "error";
      } else if (data.phase === "start") {
        action = "tool.execute";
      } else {
        action = "tool.execute";
      }

      const auditEvent = createAgentAuditEvent(
        action,
        {
          runId: event.runId,
          toolName: data.name ?? "unknown",
          toolCallId: data.callId ?? event.runId,
          phase: (data.phase as "start" | "end" | "error") ?? "start",
          input: redactSensitiveData(data.input),
          output: truncateOutput(data.output),
          durationMs: data.durationMs,
        },
        severity,
      );

      await logAuditEvent(homeDir, auditEvent);
    } catch (error) {
      console.error("Failed to log agent audit event:", error);
    }
  });
}

/**
 * Stop subscribing to agent events.
 */
export function stopAuditSubscriber(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  homeDir = null;
}

/**
 * Redact sensitive data from tool input.
 */
function redactSensitiveData(input?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!input) return undefined;

  const sensitiveKeys = ["password", "apiKey", "api_key", "secret", "token", "credential", "auth"];

  const redacted = { ...input };

  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      redacted[key] = "[REDACTED]";
    }
  }

  return redacted;
}

/**
 * Truncate large output values.
 */
function truncateOutput(output?: unknown): unknown {
  if (output === undefined) return undefined;

  const str = typeof output === "string" ? output : JSON.stringify(output);

  if (str.length > 1000) {
    return str.slice(0, 1000) + "... [truncated]";
  }

  return output;
}
