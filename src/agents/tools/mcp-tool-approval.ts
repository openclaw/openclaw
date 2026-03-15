/**
 * MCP/plugin tool approval gate.
 *
 * Wraps an MCP/plugin tool so that before any call is executed, the tool name
 * is evaluated against the tool approval policy. If the policy denies the tool
 * or requires interactive approval, the tool returns an error or waits for
 * an operator decision.
 *
 * This follows the same pattern as the exec and HTTP approval systems:
 *   1. Evaluate the policy (security + allowlist + ask).
 *   2. If approval is required, register a pending request via the gateway.
 *   3. Wait for operator decision or timeout.
 *   4. Apply askFallback on timeout.
 */

import { randomUUID } from "node:crypto";
import {
  evaluateToolApprovalPolicy,
  type ResolvedToolApprovalPolicy,
} from "../../infra/tool-approval-policy.js";
import { DEFAULT_TOOL_APPROVAL_TIMEOUT_MS } from "../../infra/tool-approvals.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { callGatewayTool } from "./gateway.js";

// Timeout for the gateway RPC call itself (not the approval wait).
// Aligned with DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS (exec flow) because the
// registration RPC may block on forwarder.handleRequested before responding.
const APPROVAL_REQUEST_TIMEOUT_MS = 130_000;

// Runtime set of tool names that have been granted allow-always during this
// process lifetime. This avoids re-prompting for the same tool within a session.
// Keys are scoped by agent+policy context so that an approval granted under one
// agent/policy does not leak to a different agent or stricter policy.
const runtimeAllowedTools = new Set<string>();

function allowAlwaysCacheKey(
  toolName: string,
  agentId: string | undefined,
  policy: ResolvedToolApprovalPolicy,
): string {
  return `${agentId ?? ""}:${policy.security}:${policy.ask}:${toolName}`;
}

export type ToolApprovalGateOptions = {
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

/**
 * Wraps an MCP/plugin tool with tool approval policy enforcement.
 * Returns the original tool unmodified if the policy is security=full + ask=off
 * (the default permissive configuration).
 */
export function withToolApprovalGate(
  tool: AnyAgentTool,
  opts: ToolApprovalGateOptions & { policy: ResolvedToolApprovalPolicy },
): AnyAgentTool {
  if (!tool) {
    return tool;
  }

  const { policy } = opts;
  const originalExecute = tool.execute;

  return {
    ...tool,
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      const toolName = tool.name || "";
      if (!toolName) {
        // Let the original tool handle the missing name.
        return originalExecute(toolCallId, args);
      }

      // Runtime allow-always: skip approval if previously granted under this
      // agent+policy context. Re-evaluate the current policy first so a stricter
      // policy (e.g. security=deny) is never bypassed by a stale cache entry.
      const cacheKey = allowAlwaysCacheKey(toolName, opts.agentId, policy);
      if (runtimeAllowedTools.has(cacheKey)) {
        const currentDecision = evaluateToolApprovalPolicy({ toolName, policy });
        if (currentDecision.allowed || currentDecision.requiresApproval) {
          return originalExecute(toolCallId, args);
        }
        // Policy now denies this tool outright. Remove stale cache entry.
        runtimeAllowedTools.delete(cacheKey);
      }

      const decision = evaluateToolApprovalPolicy({ toolName, policy });

      // Denied outright (security=deny or allowlist miss with ask=off).
      if (!decision.allowed && !decision.requiresApproval) {
        const reason =
          decision.security === "deny"
            ? "TOOL_CALL_DENIED: security=deny"
            : "TOOL_CALL_DENIED: tool not in allowlist";
        return jsonResult({ error: reason, toolName });
      }

      // Approval required: register with the gateway and wait for decision.
      if (decision.requiresApproval) {
        const approvalId = randomUUID();
        const approvalDecision = await requestToolApproval({
          id: approvalId,
          toolName,
          args,
          agentId: opts.agentId,
          sessionKey: opts.sessionKey,
          turnSourceChannel: opts.turnSourceChannel,
          turnSourceTo: opts.turnSourceTo,
          turnSourceAccountId: opts.turnSourceAccountId,
          turnSourceThreadId: opts.turnSourceThreadId,
        });

        if (approvalDecision === "allow-always") {
          runtimeAllowedTools.add(cacheKey);
          return originalExecute(toolCallId, args);
        }
        if (approvalDecision === "allow-once") {
          return originalExecute(toolCallId, args);
        }

        // Denied or timed out. Apply askFallback.
        if (approvalDecision === "deny") {
          return jsonResult({ error: "TOOL_CALL_DENIED: operator denied the request", toolName });
        }

        // Timed out (null). Apply askFallback.
        if (decision.askFallback === "full") {
          return originalExecute(toolCallId, args);
        }
        if (decision.askFallback === "allowlist" && decision.evaluation.allowlistSatisfied) {
          return originalExecute(toolCallId, args);
        }

        return jsonResult({
          error: "TOOL_CALL_DENIED: approval timed out and askFallback denied",
          toolName,
        });
      }

      // Allowed by policy. Proceed.
      return originalExecute(toolCallId, args);
    },
  };
}

type ToolApprovalDecision = "allow-once" | "allow-always" | "deny" | null;

async function requestToolApproval(params: {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): Promise<ToolApprovalDecision> {
  try {
    // Phase 1: register the approval request (two-phase).
    const registrationResult = await callGatewayTool<{
      id?: string;
      decision?: string;
      status?: string;
    }>(
      "tool.approval.request",
      { timeoutMs: APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: params.id,
        toolName: params.toolName,
        args: params.args,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        timeoutMs: DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      },
      { expectFinal: false },
    );

    // If the gateway returned a decision immediately (no approval clients),
    // the decision field is present.
    if (registrationResult && Object.hasOwn(registrationResult, "decision")) {
      return normalizeDecision(registrationResult.decision);
    }

    // Phase 2: wait for the operator decision.
    const decisionResult = await callGatewayTool<{ decision?: string }>(
      "tool.approval.waitDecision",
      { timeoutMs: DEFAULT_TOOL_APPROVAL_TIMEOUT_MS + APPROVAL_REQUEST_TIMEOUT_MS },
      { id: params.id },
    );
    return normalizeDecision(decisionResult?.decision);
  } catch {
    // Network/gateway error: block (deny) to avoid failing open.
    return "deny";
  }
}

function normalizeDecision(value: unknown): ToolApprovalDecision {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return null;
}
