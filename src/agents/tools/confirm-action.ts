/**
 * Confirm Action tool: Perplexity Computer-style human-in-the-loop gate.
 *
 * Before performing any sensitive action, the agent MUST call this tool.
 * It pauses execution, requests user approval, and logs the decision to
 * the audit log.
 *
 * Risk classification:
 *   low    - Read-only operations (no approval needed, auto-approved)
 *   medium - Data modification (requires approval)
 *   high   - Destructive, external, or irreversible actions (requires approval + explicit confirm)
 *
 * Examples of sensitive actions:
 *   - Sending email or messages
 *   - Making purchases
 *   - Deleting files or data
 *   - Posting to external services
 *   - Making API calls that modify state
 */

import { Type } from "@sinclair/typebox";
import { getAuditLogger } from "../../acp/audit-log.js";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ACTION_RISK_LEVELS = ["low", "medium", "high"] as const;
type ActionRiskLevel = (typeof ACTION_RISK_LEVELS)[number];

const CONFIRM_ACTIONS_TOOL = ["request", "audit"] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfirmActionSchema = Type.Object({
  /** Tool action: request approval or view audit log */
  action: optionalStringEnum(CONFIRM_ACTIONS_TOOL),
  /** Type of action being requested (e.g., "email.send", "file.delete") */
  actionType: Type.Optional(Type.String()),
  /** Human-readable description of what the agent wants to do */
  description: Type.Optional(Type.String()),
  /** Risk level of the action */
  risk: optionalStringEnum(ACTION_RISK_LEVELS),
  /** Structured details about the action */
  details: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** For audit: number of recent entries to retrieve */
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  /** For audit: filter by decision */
  decisionFilter: optionalStringEnum(["approved", "denied", "auto-approved", "timed-out"]),
});

// ---------------------------------------------------------------------------
// Action classification helpers
// ---------------------------------------------------------------------------

/** Returns the default risk level for common action types. */
function inferRiskLevel(actionType: string): ActionRiskLevel {
  const lower = actionType.toLowerCase();

  // High-risk patterns
  if (
    /\b(delete|destroy|remove|purge|wipe|drop|truncate)\b/.test(lower) ||
    /\b(purchase|buy|pay|charge|billing|subscription)\b/.test(lower) ||
    /\b(publish|deploy|release|push|merge)\b/.test(lower) ||
    /\b(send|post|submit|broadcast)\b.*\b(email|message|tweet|post|sms)\b/.test(lower)
  ) {
    return "high";
  }

  // Medium-risk patterns
  if (
    /\b(write|create|update|edit|modify|upload|import)\b/.test(lower) ||
    /\b(api|webhook|external|third.party)\b/.test(lower)
  ) {
    return "medium";
  }

  return "low";
}

/** Returns true if this action type can be auto-approved. */
function canAutoApprove(risk: ActionRiskLevel): boolean {
  return risk === "low";
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createConfirmActionTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
  /** If true, all non-low-risk actions are auto-denied for safety. */
  strictMode?: boolean;
}): AnyAgentTool {
  const auditLogger = getAuditLogger();

  return {
    label: "Confirm Action",
    name: "confirm_action",
    description:
      "Request user approval before performing sensitive actions (email, delete, purchase, post, etc). " +
      "Use action=request to pause and ask the user. Low-risk read-only actions are auto-approved. " +
      "Use action=audit to view recent action history.",
    parameters: ConfirmActionSchema,
    ownerOnly: false,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolAction = (readStringParam(params, "action") ?? "request") as "request" | "audit";

      // --- audit ---
      if (toolAction === "audit") {
        const limit = typeof params.limit === "number" ? Math.min(200, Math.max(1, params.limit)) : 50;
        const decisionFilter = readStringParam(params, "decisionFilter") as
          | "approved"
          | "denied"
          | "auto-approved"
          | "timed-out"
          | undefined;
        const entries = auditLogger.query({
          sessionKey: opts?.agentSessionKey,
          decision: decisionFilter,
          limit,
        });
        return jsonResult({
          status: "ok",
          action: "audit",
          total: entries.length,
          summary: auditLogger.formatSummary(entries),
          entries: entries.slice(-20), // Only return last 20 in JSON
        });
      }

      // --- request ---
      const actionType = readStringParam(params, "actionType", { required: true });
      const description = readStringParam(params, "description", { required: true });
      const rawRisk = readStringParam(params, "risk") as ActionRiskLevel | undefined;
      const risk = rawRisk ?? inferRiskLevel(actionType);
      const details =
        params.details && typeof params.details === "object" && !Array.isArray(params.details)
          ? (params.details as Record<string, unknown>)
          : undefined;

      // Auto-approve low-risk actions
      if (canAutoApprove(risk)) {
        auditLogger.append({
          sessionKey: opts?.agentSessionKey,
          agentId: opts?.agentId,
          actionType,
          description,
          details,
          decision: "auto-approved",
          decidedBy: "system",
        });
        return jsonResult({
          status: "approved",
          decision: "auto-approved",
          risk,
          actionType,
          message: "Low-risk action auto-approved.",
        });
      }

      // Strict mode: deny all medium/high-risk actions
      if (opts?.strictMode) {
        auditLogger.append({
          sessionKey: opts?.agentSessionKey,
          agentId: opts?.agentId,
          actionType,
          description,
          details,
          decision: "denied",
          decidedBy: "system",
          denyReason: "Strict mode: all non-low-risk actions require manual override",
        });
        return jsonResult({
          status: "denied",
          decision: "denied",
          risk,
          actionType,
          reason: "Strict mode is enabled. This action requires manual override.",
        });
      }

      // For medium/high risk: return a pending approval request.
      // In a full gateway integration, this would pause execution and
      // send an approval request to the user's messaging channel.
      // For now, we log it and return the pending state.
      auditLogger.append({
        sessionKey: opts?.agentSessionKey,
        agentId: opts?.agentId,
        actionType,
        description,
        details,
        decision: "timed-out",
        decidedBy: "timeout",
        denyReason: "Approval pending — user has not yet responded",
      });

      const riskWarning =
        risk === "high"
          ? "⚠️  HIGH RISK: This action is destructive or irreversible."
          : "This action modifies external state.";

      return jsonResult({
        status: "pending",
        decision: "pending",
        risk,
        actionType,
        description,
        details,
        message:
          `${riskWarning}\n\n` +
          `The agent wants to: ${description}\n\n` +
          `Action type: ${actionType}\n` +
          `To approve, send: "approved" or "yes"\n` +
          `To deny, send: "denied" or "no"`,
        instructions:
          "Reply to this message with 'approved' to allow the action, or 'denied' to block it.",
      });
    },
  };
}
