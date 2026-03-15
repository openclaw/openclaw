/**
 * HTTP/fetch tool approval gate.
 *
 * Wraps a web_fetch tool so that before any fetch is executed, the URL is
 * evaluated against the HTTP approval policy. If the policy denies the URL
 * or requires interactive approval, the tool returns an error or waits for
 * an operator decision.
 *
 * This follows the same pattern as the exec approval system:
 *   1. Evaluate the policy (security + allowlist + ask).
 *   2. If approval is required, register a pending request via the gateway.
 *   3. Wait for operator decision or timeout.
 *   4. Apply askFallback on timeout.
 */

import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateHttpApprovalPolicy,
  resolveHttpApprovalPolicy,
} from "../../infra/http-approval-policy.js";
import { matchHttpAllowlist } from "../../infra/http-approvals-allowlist.js";
import {
  DEFAULT_HTTP_APPROVAL_TIMEOUT_MS,
  resolveHttpAllowAlwaysPattern,
} from "../../infra/http-approvals.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { callGatewayTool } from "./gateway.js";

// Timeout for the gateway RPC call itself (not the approval wait).
const APPROVAL_REQUEST_TIMEOUT_MS = 10_000;

export type HttpApprovalGateOptions = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

/**
 * Wraps a web_fetch tool with HTTP approval policy enforcement.
 * Returns the original tool unmodified if the policy is security=full + ask=off
 * (the default permissive configuration).
 */
export function withHttpApprovalGate(
  tool: AnyAgentTool,
  opts: HttpApprovalGateOptions,
): AnyAgentTool {
  if (!tool) {
    return tool;
  }

  const config = opts.config;
  const policy = resolveHttpApprovalPolicy({
    cfg: config ?? ({} as OpenClawConfig),
    agentId: opts.agentId,
  });

  // Fast path: default permissive policy needs no wrapping.
  if (policy.security === "full" && policy.ask === "off") {
    return tool;
  }

  const originalExecute = tool.execute;

  // Runtime cache of allow-always patterns so that subsequent fetches to the
  // same host are allowed immediately without waiting for config reload.
  const runtimeAllowedPatterns: Array<{ pattern: string }> = [];

  return {
    ...tool,
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      // Check all known URL parameter shapes: url, navigate, targetUrl.
      // Browser tools use targetUrl (via readTargetUrlParam in browser-tool.ts).
      const url = extractUrlFromArgs(args);
      if (!url) {
        // Let the original tool handle the missing URL error.
        return originalExecute(toolCallId, args);
      }

      // Check the runtime allow-always cache before policy evaluation.
      // This allows "allow-always" to take effect immediately for subsequent
      // fetches without waiting for config reload.
      if (runtimeAllowedPatterns.length > 0 && matchHttpAllowlist(runtimeAllowedPatterns, url)) {
        return originalExecute(toolCallId, args);
      }

      const decision = evaluateHttpApprovalPolicy({ url, policy });

      // Denied outright (security=deny or allowlist miss with ask=off).
      if (!decision.allowed && !decision.requiresApproval) {
        const reason =
          decision.security === "deny"
            ? "HTTP_FETCH_DENIED: security=deny"
            : "HTTP_FETCH_DENIED: URL not in allowlist";
        return jsonResult({ error: reason, url });
      }

      // Approval required: register with the gateway and wait for decision.
      if (decision.requiresApproval) {
        const approvalId = randomUUID();
        const approvalDecision = await requestHttpApproval({
          id: approvalId,
          url,
          method: "GET",
          agentId: opts.agentId,
          sessionKey: opts.sessionKey,
          turnSourceChannel: opts.turnSourceChannel,
          turnSourceTo: opts.turnSourceTo,
          turnSourceAccountId: opts.turnSourceAccountId,
          turnSourceThreadId: opts.turnSourceThreadId,
        });

        if (approvalDecision === "allow-once" || approvalDecision === "allow-always") {
          // Record allow-always patterns in the runtime cache so future
          // fetches to the same host bypass approval immediately.
          if (approvalDecision === "allow-always") {
            const pattern = resolveHttpAllowAlwaysPattern(url);
            if (pattern && !runtimeAllowedPatterns.some((e) => e.pattern === pattern)) {
              runtimeAllowedPatterns.push({ pattern });
            }
          }
          return originalExecute(toolCallId, args);
        }

        // Denied or timed out. Apply askFallback.
        if (approvalDecision === "deny") {
          return jsonResult({ error: "HTTP_FETCH_DENIED: operator denied the request", url });
        }

        // Timed out (null). Apply askFallback.
        if (decision.askFallback === "full") {
          return originalExecute(toolCallId, args);
        }
        if (decision.askFallback === "allowlist" && decision.evaluation.allowlistSatisfied) {
          return originalExecute(toolCallId, args);
        }

        return jsonResult({
          error: "HTTP_FETCH_DENIED: approval timed out and askFallback denied",
          url,
        });
      }

      // Allowed by policy. Proceed.
      return originalExecute(toolCallId, args);
    },
  };
}

type HttpApprovalDecision = "allow-once" | "allow-always" | "deny" | null;

async function requestHttpApproval(params: {
  id: string;
  url: string;
  method?: string;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}): Promise<HttpApprovalDecision> {
  try {
    // Phase 1: register the approval request (two-phase).
    const registrationResult = await callGatewayTool<{
      id?: string;
      decision?: string;
      status?: string;
    }>(
      "http.approval.request",
      { timeoutMs: APPROVAL_REQUEST_TIMEOUT_MS },
      {
        id: params.id,
        url: params.url,
        method: params.method,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        turnSourceChannel: params.turnSourceChannel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
        turnSourceThreadId: params.turnSourceThreadId,
        timeoutMs: DEFAULT_HTTP_APPROVAL_TIMEOUT_MS,
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
      "http.approval.waitDecision",
      { timeoutMs: DEFAULT_HTTP_APPROVAL_TIMEOUT_MS + APPROVAL_REQUEST_TIMEOUT_MS },
      { id: params.id },
    );
    return normalizeDecision(decisionResult?.decision);
  } catch {
    // Network/gateway error: block (deny) to avoid failing open.
    // If the approval channel is unhealthy, the safe default is to deny
    // rather than silently allowing the request through.
    return "deny";
  }
}

function normalizeDecision(value: unknown): HttpApprovalDecision {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return null;
}

/**
 * Extract the target URL from tool call args.
 * Handles multiple parameter shapes:
 *   - `url` (web_fetch, browser navigate)
 *   - `targetUrl` (browser open/navigate via readTargetUrlParam)
 *   - `navigate` (legacy browser navigate)
 */
function extractUrlFromArgs(args: Record<string, unknown>): string {
  for (const key of ["url", "targetUrl", "navigate"]) {
    const value = args[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}
